import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// 1. 환경 변수(GitHub Secrets)로부터 설정 값 주입
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MY_USER_ID = process.env.MY_USER_ID;
const GAS_URL = "https://script.google.com/macros/s/AKfycbwe2VssvmIlGMUrX0APMo8XYIWRWP0yTpTZw8KPYhtIoaj-ol8dtafnByZoB9ljtf0/exec";

// 2. service_role 키를 사용하여 RLS를 우회하는 마스터 클라이언트 생성
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runAutomation() {
    try {
        console.log("🚀 1단계: Google Apps Script(GAS)로부터 실시간 시세 조회 중...");
        const gasRes = await fetch(`${GAS_URL}?t=${new Date().getTime()}`);
        const gasJson = await gasRes.json();
        
        if (!gasJson || gasJson.status !== "success" || !gasJson.stockPrices) {
            throw new Error("GAS로부터 유효한 시세 데이터를 받지 못했습니다.");
        }
        const cachedGasData = gasJson.stockPrices;
        console.log("✅ GAS 시세 로드 성공!");

        console.log("🚀 2단계: Supabase 원천 데이터(거래 내역 및 예적금) 가져오는 중...");
        
        // RLS 무시 권한이므로 전체를 긁어온 뒤 내 user_id 데이터만 필터링하여 계산합니다.
        const { data: trades, error: tradeError } = await supabase.from('tb_stock_trade').select('*').eq('user_id', MY_USER_ID);
        if (tradeError) throw tradeError;

        const { data: deposits, error: depositError } = await supabase.from('deposit_management').select('total_amount').eq('user_id', MY_USER_ID).eq('status', '유지');
        if (depositError) throw depositError;

        console.log("🚀 3단계: 대시보드 로직 기반 실시간 가치 정산 알고리즘 가동...");
        
        // 주식/채권/금은 잔고 정산
        const stockMap = {};
        (trades || []).forEach(trade => {
            const key = trade.stock_code || trade.stock_name;
            if (!stockMap[key]) {
                stockMap[key] = { asset_type: trade.asset_type, stock_code: trade.stock_code, balance: 0, total_cost: 0 };
            }
            const s = stockMap[key];
            const qty = parseFloat(trade.quantity) || 0;
            const amt = parseFloat(trade.amount_krw) || 0;

            if (trade.trade_side === '매수') {
                s.balance += qty;
                s.total_cost += amt;
            } else if (trade.trade_side === '매도') {
                s.balance -= qty;
                if (s.balance <= 0) {
                    s.balance = 0;
                    s.total_cost = 0;
                }
            }
        });

        let stockSum = 0, bondSum = 0, goldSum = 0, cashSum = 0;

        // 실시간 주가 매칭 계산
        Object.values(stockMap).filter(s => s.balance > 0).forEach(s => {
            const avgPrice = s.total_cost / s.balance;
            let livePrice = avgPrice; // Fallback 기본값

            if (s.stock_code && cachedGasData[s.stock_code]) {
                let gPrice = cachedGasData[s.stock_code].price || 0;
                if (gPrice > 0) livePrice = gPrice;
            }
            
            const liveCurrentKrw = s.balance * livePrice;

            if (s.asset_type === '주식') stockSum += liveCurrentKrw;
            else if (s.asset_type === '채권') bondSum += liveCurrentKrw;
            else if (s.asset_type === '금은') goldSum += liveCurrentKrw;
        });

        // 현금성 자산 합산
        (deposits || []).forEach(d => {
            cashSum += parseFloat(d.total_amount) || 0;
        });

        const totalSum = stockSum + bondSum + goldSum + cashSum;
        
        // 현재 연-월 구하기 (예: 2026-05)
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const snapshotMonth = `${year}-${month}`;

        console.log(`📊 계산된 자산 요약 (${snapshotMonth}):`);
        console.log(`- 총자산: ${Math.floor(totalSum).toLocaleString()} 원`);
        console.log(`- 주식: ${Math.floor(stockSum).toLocaleString()} 원`);
        console.log(`- 채권: ${Math.floor(bondSum).toLocaleString()} 원`);
        console.log(`- 현금: ${Math.floor(cashSum).toLocaleString()} 원`);
        console.log(`- 금은: ${Math.floor(goldSum).toLocaleString()} 원`);

        console.log("🚀 4단계: Supabase 'tb_monthly_snapshot' 테이블에 데이터 적재 중...");

        // 스냅샷 데이터 Upsert 처리 (user_id와 snapshot_month 기반 고유 체크 설정 필요)
        const { data, error: upsertError } = await supabase
            .from('tb_monthly_snapshot')
            .upsert({
                user_id: MY_USER_ID,
                snapshot_month: snapshotMonth,
                total_sum: Math.floor(totalSum),
                stock_sum: Math.floor(stockSum),
                bond_sum: Math.floor(bondSum),
                cash_sum: Math.floor(cashSum),
                gold_sum: Math.floor(goldSum)
            }, {
                onConflict: 'user_id,snapshot_month' // 중복 발생 시 업데이트 치도록 유도
            });

        if (upsertError) throw upsertError;

        console.log("✨ [성공] 10분 주기 스냅샷 동기화가 완벽하게 완료되었습니다!");

    } catch (error) {
        console.error("❌ [실패] 크론 스크립트 실행 중 치명적 오류 발생:", error.message);
        process.exit(1);
    }
}

runAutomation();