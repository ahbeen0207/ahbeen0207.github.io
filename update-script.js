// update-script.js
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); // node-fetch@2 버전을 사용하여 깔끔하게 require

// 환경 변수 세팅
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const MY_USER_ID = process.env.MY_USER_ID;
const GAS_URL = "https://script.google.com/macros/s/AKfycbwe2VssvmIlGMUrX0APMo8XYIWRWP0yTpTZw8KPYhtIoaj-ol8dtafnByZoB9ljtf0/exec";

// 관리자 권한 클라이언트 생성
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runAutomation() {
    try {
        console.log("🚀 1단계: GAS로부터 실시간 주가(구글파이낸스) 데이터 조회 중...");
        
        const gasRes = await fetch(`${GAS_URL}?t=${new Date().getTime()}`);
        const gasJson = await gasRes.json();
        
        if (!gasJson || gasJson.status !== "success" || !gasJson.stockPrices) {
            throw new Error("GAS로부터 유효한 시세 데이터를 받지 못했습니다.");
        }
        const cachedGasData = gasJson.stockPrices;
        console.log("✅ GAS 시세 받아오기 성공!");

        console.log("🚀 2단계: Supabase에서 거래 내역(`tb_stock_trade`) 및 예적금 가져오는 중...");
        const { data: trades, error: tradeError } = await supabase.from('tb_stock_trade').select('*').eq('user_id', MY_USER_ID);
        if (tradeError) throw tradeError;

        const { data: deposits, error: depositError } = await supabase.from('deposit_management').select('total_amount').eq('user_id', MY_USER_ID).eq('status', '유지');
        if (depositError) throw depositError;

        console.log("🚀 3단계: 종목별 잔고 및 자산 총액 실시간 계산 중...");
        
        const stockMap = {};
        (trades || []).forEach(trade => {
            const key = trade.stock_code || trade.stock_name;
            if (!stockMap[key]) {
                stockMap[key] = { 
                    asset_type: trade.asset_type, 
                    stock_name: trade.stock_name, 
                    stock_code: trade.stock_code || trade.stock_name, 
                    balance: 0, 
                    total_cost: 0 
                };
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
        const stockStatusRows = [];
        const currentTime = new Date().toISOString(); 

        Object.values(stockMap).filter(s => s.balance > 0).forEach(s => {
            const avgPrice = s.total_cost / s.balance;
            let livePrice = avgPrice; 

            if (s.stock_code && cachedGasData[s.stock_code]) {
                let gPrice = cachedGasData[s.stock_code].price || 0;
                if (gPrice > 0) livePrice = gPrice;
            }
            
            const evalAmount = s.balance * livePrice;
            const profitLoss = evalAmount - s.total_cost;
            const returnRate = s.total_cost > 0 ? (profitLoss / s.total_cost) * 100 : 0;

            if (s.asset_type === '주식') stockSum += evalAmount;
            else if (s.asset_type === '채권') bondSum += evalAmount;
            else if (s.asset_type === '금은') goldSum += evalAmount;

            stockStatusRows.push({
                user_id: MY_USER_ID,
                asset_type: s.asset_type,
                stock_name: s.stock_name,
                stock_code: s.stock_code,
                balance: s.balance,
                avg_price: Math.round(avgPrice * 100) / 100,
                total_cost: Math.floor(s.total_cost),
                live_price: Math.floor(livePrice),
                eval_amount: Math.floor(evalAmount),
                profit_loss: Math.floor(profitLoss),
                return_rate: Math.round(returnRate * 100) / 100,
                updated_at: currentTime
            });
        });

        (deposits || []).forEach(d => {
            cashSum += parseFloat(d.total_amount) || 0;
        });

        const totalSum = stockSum + bondSum + goldSum + cashSum;

        console.log("🚀 4단계: Supabase `tb_realtime_stock_status` 테이블 적재...");
        if (stockStatusRows.length > 0) {
            const { error: stockUpsertError } = await supabase
                .from('tb_realtime_stock_status')
                .upsert(stockStatusRows, { onConflict: 'user_id,stock_code' });
            if (stockUpsertError) throw stockUpsertError;
            console.log(`✅ 보유 종목 ${stockStatusRows.length}건 실시간 동기화 완료!`);
        }

        console.log("🚀 5단계: Supabase `tb_realtime_asset_summary` 테이블 적재...");
        const { error: assetUpsertError } = await supabase
            .from('tb_realtime_asset_summary')
            .upsert({
                user_id: MY_USER_ID,
                stock_sum: Math.floor(stockSum),
                bond_sum: Math.floor(bondSum),
                cash_sum: Math.floor(cashSum),
                gold_sum: Math.floor(goldSum),
                total_sum: Math.floor(totalSum),
                updated_at: currentTime
            }, { onConflict: 'user_id' });
            
        if (assetUpsertError) throw assetUpsertError;
        console.log("✅ 전체 자산 총액 요약 실시간 업데이트 완료!");
        console.log(`✨ 최종 동기화 시간: ${new Date(currentTime).toLocaleString()}`);

    } catch (error) {
        console.error("❌ [크론 실패] 오류 발생:", error.message);
        process.exit(1);
    }
}

runAutomation();
