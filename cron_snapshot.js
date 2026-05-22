// cron_snapshot.js
const { createClient } = require('@supabase/supabase-js');

// GitHub 가상 서버 환경변수에서 보안 키들을 꺼내옵니다.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const TARGET_USER_ID = process.env.MY_USER_ID; 

// 구글 GAS 실시간 가격 API 주소
const googleGasUrl = "https://script.google.com/macros/s/AKfycbwe2VssvmIlGMUrX0APMo8XYIWRWP0yTpTZw8KPYhtIoaj-ol8dtafnByZoB9ljtf0/exec";

// 마스터 권한으로 Supabase 클라이언트 개설
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runSnapshot() {
    console.log("🚀 월별 자산 스냅샷 배치 정산 시작...");
    
    try {
        // 1. 구글 실시간 시세 조회
        console.log("1. 구글 실시간 시세 조회 중...");
        const gasRes = await fetch(googleGasUrl);
        const gasJson = await gasRes.json();
        const cachedGasData = (gasJson && gasJson.status === "success") ? gasJson.stockPrices : {};

        // 2. 주식/채권/금은 데이터 가져와서 정산 (해당 유저 데이터만)
        console.log("2. 주식/채권/금은 거래 내역 정산 중...");
        const { data: trades, error: tradeError } = await supabase
            .from('tb_stock_trade')
            .select('*')
            .eq('user_id', TARGET_USER_ID);
        
        if (tradeError) throw tradeError;

        const stockMap = {};
        (trades || []).forEach(trade => {
            const key = trade.stock_code || trade.stock_name;
            if (!stockMap[key]) {
                stockMap[key] = { asset_type: trade.asset_type, stock_code: trade.stock_code, balance: 0, total_cost: 0 };
            }
            const s = stockMap[key];
            const qty = parseFloat(trade.quantity) || 0;
            const amt = parseFloat(trade.amount_krw) || 0;
            if (trade.trade_side === '매수') { s.balance += qty; s.total_cost += amt; }
            else if (trade.trade_side === '매도') { s.balance -= qty; s.total_cost -= amt; }
        });

        let stockSum = 0, bondSum = 0, goldSum = 0;
        Object.values(stockMap).filter(s => s.balance > 0).forEach(s => {
            const livePrice = (cachedGasData && cachedGasData[s.stock_code]) ? cachedGasData[s.stock_code].price : (s.total_cost / s.balance);
            const liveCurrentKrw = s.balance * livePrice;
            if (s.asset_type === '주식') stockSum += liveCurrentKrw;
            else if (s.asset_type === '채권') bondSum += liveCurrentKrw;
            else if (s.asset_type === '금은') goldSum += liveCurrentKrw;
        });

        // 3. 예적금 현금 가져와서 정산 (해당 유저의 '유지' 상태만)
        console.log("3. 예적금/현금 자산 정산 중...");
        const { data: deposits, error: depositError } = await supabase
            .from('deposit_management')
            .select('total_amount')
            .eq('user_id', TARGET_USER_ID)
            .eq('status', '유지');
        
        if (depositError) throw depositError;

        let cashSum = 0;
        (deposits || []).forEach(d => { cashSum += parseFloat(d.total_amount) || 0; });

        const totalSum = stockSum + bondSum + goldSum + cashSum;

        // 4. 날짜 계산 (실행 시점 기준 한 달 전 달을 'snapshot_month'로 지정)
        // 💡 테스트용 꿀팁: 지금 수동 실행해서 '2026-05' 데이터를 즉시 꼽고 싶다면 아래 3줄을 그대로 유지하시면 됩니다.
        const now = new Date();
        now.setHours(now.getHours() + 9); // 한국 시간 보정
        now.setMonth(now.getMonth() - 1); // 한 달 전 날짜 취득
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const snapshotMonth = `${year}-${month}`; // 결과: "2026-05"

        console.log(`📊 정산 결과 요약 [대상월: ${snapshotMonth}]`);
        console.log(`- 주식: ${Math.round(stockSum)}원 / 채권: ${Math.round(bondSum)}원 / 현금: ${Math.round(cashSum)}원 / 금은: ${Math.round(goldSum)}원`);
        console.log(`- 총자산: ${Math.round(totalSum)}원`);

        // 5. Supabase에 최종 스냅샷 저장
        const { error: upsertError } = await supabase.from('tb_monthly_snapshot').upsert([{
            user_id: TARGET_USER_ID, 
            snapshot_month: snapshotMonth,
            stock_sum: Math.round(stockSum),
            bond_sum: Math.round(bondSum),
            cash_sum: Math.round(cashSum),
            gold_sum: Math.round(goldSum),
            total_sum: Math.round(totalSum)
        }], { onConflict: 'user_id,snapshot_month' });

        if (upsertError) throw upsertError;
        console.log(`✅ ${snapshotMonth} 자산 스냅샷 테이블에 데이터 적재 완료!`);
        
    } catch (e) {
        console.error("❌ 배치 실행 중 치명적 오류 발생:", e.message);
        process.exit(1);
    }
}

runSnapshot();