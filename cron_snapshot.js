// cron_snapshot.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const TARGET_USER_ID = process.env.MY_USER_ID; 

const googleGasUrl = "https://script.google.com/macros/s/AKfycbwe2VssvmIlGMUrX0APMo8XYIWRWP0yTpTZw8KPYhtIoaj-ol8dtafnByZoB9ljtf0/exec";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runSnapshot() {
    console.log("🚀 월별 자산 스냅샷 배치 정산 시작...");
    try {
        console.log("1. 구글 실시간 시세 조회 중...");
        
        // 💡 fetch 버전 오류를 차단하기 위해 동적 임포트(Dynamic Import) 표준 문법으로 안전하게 데이터를 수집합니다.
        const { default: fetch } = await import('node-fetch');
        
        const gasRes = await fetch(googleGasUrl);
        const gasJson = await gasRes.json();
        const cachedGasData = (gasJson && gasJson.status === "success") ? gasJson.stockPrices : {};

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

        const now = new Date();
        now.setHours(now.getHours() + 9); // 한국 시간 보정
        now.setMonth(now.getMonth() - 1); // 안전하게 한 달 전 날짜 매핑 (6월 가동 시 5월로 기록)
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const snapshotMonth = `${year}-${month}`;

        console.log(`📊 대상월: ${snapshotMonth} 정산 완료`);

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
        console.log(`✅ 데이터베이스 적재 성공!`);
    } catch (e) {
        console.error("❌ 오류 발생:", e.message);
        process.exit(1);
    }
}
runSnapshot();
