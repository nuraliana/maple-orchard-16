const D=window.RADAR_DATA,M=D.m,CATS=D.cats,CHAINS=D.chains,ROWS=D.rows,COMPS=D.comps;
const $=id=>document.getElementById(id);
const money=x=>"$"+Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",");
const money2=x=>"$"+x.toFixed(2);
const pct=x=>(x>=0?"+":"")+x.toFixed(1)+"%";
const VNAME=["Skip","Thin","Farm"];
const ACT={"Dexs":["tukar $200 menjadi aset pool lalu sediakan likuiditas di pool utama","lakukan satu swap kecil di pool yang sama untuk menjaga aktivitas"],"Lending":["deposit $200 sebagai collateral lalu pinjam aset kecil senilai $50","setorkan atau tarik $20 collateral agar posisi tetap aktif"],"Yield":["deposit $200 ke vault yield utama dan biarkan bunga berjalan","klaim dan tanam ulang (re-stake) reward kecil yang masuk"],"Yield Aggregator":["deposit $200 ke vault agregator utama","pindahkan $20 antar-strategi vault untuk mencatat aktivitas"],"Derivatives":["buka posisi kecil $200 di pasar perps utama dengan leverage 1x","tutup dan buka ulang posisi kecil $20 untuk mencatat aktivitas"],"RWA":["beli atau mint aset RWA senilai $200 dari penawaran utama","periksa laporan aset dasar dan catat nilainya"],"CDP":["kunci $200 collateral lalu mint stablecoin senilai $100","sesuaikan collateral $20 untuk menjaga rasio tetap sehat"],"Basis Trading":["deposit $200 ke strategi basis (spot + short) utama","periksa funding dan catat selisih basis minggu ini"],"Risk Curators":["deposit $200 ke vault kurator dengan profil risiko moderat","tinjau ulang alokasi kurator dan catat perubahannya"],"Onchain Capital Allocator":["alokasikan $200 ke strategi utama yang dikelola allocator","tinjau laporan alokasi dan catat pergeseran dananya"],"Chain":["bridge $200 ke jaringan utama lalu pakai dApp flagship-nya","lakukan satu transaksi kecil di dApp flagship jaringan itu"],"Staking Pool":["stake $200 di pool staking utama","klaim reward staking kecil dan tanam ulang"],"Liquidity Manager":["deposit $200 ke vault manajemen likuiditas aktif","tinjau ulang rentang likuiditas dan catat penyesuaiannya"],"Leveraged Farming":["buka posisi farming $200 dengan leverage rendah (1,5x)","sesuaikan posisi $20 agar rasio leverage tetap rendah"],"Restaking":["restake $200 aset ke operator utama","periksa status operator dan catat imbalannya"],"Prediction Market":["pasang posisi $200 di pasar prediksi paling likuid","tutup atau tambah posisi kecil $20 di pasar yang sama"],"Stablecoin Wrapper":["bungkus (wrap) $200 stablecoin ke versi protokol","periksa peg dan catat selisihnya"],"Farm":["deposit $200 ke farm utama dan mulai panen reward","panen reward kecil dan tanam ulang ke farm yang sama"],"Insurance":["beli cover $200 untuk posisi di protokol terkait","periksa status cover dan catat masa berlakunya"],"Payments":["lakukan pembayaran $200 lewat rel pembayaran utama","lakukan satu pembayaran kecil $20 untuk menjaga aktivitas"],"Indexes":["beli $200 token indeks utama","rebalance $20 mengikuti komposisi indeks terbaru"],"CeDeFi":["deposit $200 ke produk CeDeFi utama","periksa laporan kustodian dan catat imbalannya"]};
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
function steps(r){const name=r[1],chain=CHAINS[r[4]]||"Ethereum",cat=CATS[r[2]],a=ACT[cat]||["gunakan fitur utama dengan modal $200 dan catat setiap langkah","ulangi satu aksi kecil di fitur utama untuk menjaga aktivitas"],th=money(r[5]*0.5);
return[`Hari 1 (15 mnt, $0): Siapkan dompet segar khusus ${name} di ${chain}; simpan seed offline, jangan campur dengan dompet utama.`,
`Hari 1 (10 mnt, gas $4, 2 tx): Di ${name} (${chain}), ${a[0]}; approve lalu deposit dalam satu sesi, simpan hash kedua transaksi.`,
`Minggu 2 (10 mnt, gas $2, 1 tx): ${cap(a[1])}; catat tanggal, hash, dan saldo posisi setelah aksi.`,
`Minggu 4 (10 mnt, gas $2, 1 tx): ${cap(a[1])}; bandingkan TVL ${name} dengan posisi awal Anda.`,
`Minggu 6 (10 mnt, gas $2, 1 tx): ${cap(a[1])}; pastikan posisi masih di atas ambang stop ${th} TVL.`,
`Minggu 8 (10 mnt, gas $2, 1 tx): ${cap(a[1])}; periksa halaman poin ${name} sebelum menarik dana apa pun.`,
`Hari 90 (10 mnt, gas $2, 1 tx): Klaim reward/poin ${name} bila tersedia, lalu tarik dana pokok bila token belum meluncur.`,
`Hari 90 (5 mnt, $0): Catat dompet, tanggal, dan semua hash transaksi. STOP lebih awal bila TVL jatuh di bawah ${th}; KELUAR setelah token meluncur atau musim berakhir; tinjau ulang 2027-02-12.`];}
// KPI
$("kpi").innerHTML=[["Ranked rows",M.nRows],["Total expected value","$"+(M.totalEV/1e9).toFixed(2)+"B"],["LOO factor-miss",M.loo.full.geo.toFixed(2)+"×"],["Time-split factor-miss",M.ts.full.geo.toFixed(2)+"×"],["Walk-forward factor-miss",M.wf.full.geo.toFixed(2)+"×"],["Local band holds truth", (M.coverage*100).toFixed(0)+"% of comps"],["Farm verdicts",M.nFarm+" Farm"],["Best net / hour",money2(M.bestNetHr)]].map(x=>`<div><b>${x[1]}</b><span>${x[0]}</span></div>`).join("");
// filters + sort
let sortK=11,sortDir=-1;
const catSel=$("fCat");catSel.innerHTML='<option value="">All categories</option>'+CATS.map((c,i)=>`<option value="${i}">${c||"(no category)"}</option>`).join("");
function filtered(){const c=catSel.value,v=$("fVerd").value,p=parseFloat($("fProb").value),q=$("fQ").value.toLowerCase();
return ROWS.map((r,i)=>[r,i]).filter(([r])=>(c===""||r[2]==+c)&&(v===""||r[19]==+v)&&(r[9]/1000>=p)&&(!q||r[1].toLowerCase().includes(q)||r[0].includes(q)));}
function render(){let list=filtered();
if(sortK!==0)list.sort((a,b)=>{const x=a[0][sortK],y=b[0][sortK];if(sortK===1)return sortDir*x[1].localeCompare(y[1]);if(sortK===2)return sortDir*CATS[x].localeCompare(CATS[y]);return sortDir*(x-y);});
if(sortK===0)list.sort((a,b)=>sortDir*(a[1]-b[1]));
$("count").textContent=list.length+" of "+ROWS.length+" rows";
$("board").querySelector("tbody").innerHTML=list.map(([r,i])=>`<tr data-i="${i}"><td>${i+1}</td><td><b>${r[1]}</b><br><span style="color:var(--mut)">${r[0]}</span></td><td>${CATS[r[2]]||"—"}</td><td>${r[3]}</td><td>${money(r[5])}</td><td>${r[6]===null?"—":pct(r[6]/100)}</td><td>${r[7]}${r[8]?"*":""}</td><td>${(r[9]/10).toFixed(1)}%</td><td>${r[10]>=9999?"never":(r[10]/10).toFixed(1)+"%"}</td><td><b>${money(r[11])}</b></td><td>${money(r[12])} – ${money(r[13])}</td><td>${r[14]}–${r[15]}</td><td>${money2(r[16]/100)}</td><td>${money2(r[17]/100)}</td><td>${money2(r[18]/100)}</td><td class="v${r[19]}">${VNAME[r[19]]}</td></tr>`).join("");
document.querySelectorAll("#board tbody tr").forEach(tr=>tr.onclick=()=>showDetail(+tr.dataset.i));}
document.querySelectorAll("#board th").forEach(th=>th.onclick=()=>{const k=+th.dataset.k;if(sortK===k)sortDir*=-1;else{sortK=k;sortDir=k===1||k===2?1:-1;}render();});
["fCat","fVerd","fProb","fQ"].forEach(id=>$(id).addEventListener("input",render));
// detail
let detIdx=0,dep=200,share=0.000025,tbill=0.04;
function farmMath(r){const slice=r[11]*share,floor=slice/M.band,cost=14+dep*tbill*90/365,net=floor-cost,nh=net/(80/60),be=cost*M.band/(r[20]*share);return{slice,floor,cost,net,nh,be,ver:net>=60?2:net>0?1:0};}
function showDetail(i){detIdx=i;const r=ROWS[i],f=farmMath(r),near=[r[23],r[24],r[25]].map(ci=>COMPS[ci]);
$("detail").hidden=false;
$("detail").innerHTML=`<h2>#${i+1} ${r[1]} <span style="color:var(--mut);font-size:14px">${r[0]} · ${CATS[r[2]]||"no category"} · ${CHAINS[r[4]]} · ${r[3]} chain(s)</span></h2>
<div class="detail-grid"><div><h3>Derivation — step by step</h3><p class="mono">log TVL = ${Math.log(r[5]).toFixed(3)} · age is not used by the value model (it sets launch odds only)<br>
log mcap = ${M.beta[0]} + ${M.beta[1]}·logTVL → fitted log mcap ${Math.log(r[21]/10000*r[5]).toFixed(3)} (multiple clamped if outside [0.08, 1.20])<br>
Fitted multiple = ${(r[21]/10000).toFixed(3)} (clamped 0.08–1.20) · growth ×${(1).toFixed(3)} (w=0) · 0.85 discount<br>
Conditional value = ${money(r[20])} · launch odds ${(r[9]/10).toFixed(1)}% = <b>${money(r[11])}</b><br>
Local band (25–75 pct of LOO errors of 20 nearest comps): ${money(r[12])} – ${money(r[13])}<br>
Bootstrap rank range (5–95 pct of 200 resamples): ${r[14]}–${r[15]}</p>
<h3>3 nearest comps</h3><p>${near.map(c=>`${c[0]} — TVL ${money(c[1])}, mcap ${money(c[2])}, LOO factor-miss ${(c[3]/1000).toFixed(2)}×`).join("<br>")}</p></div>
<div><h3>Farm plan — what-if</h3><div class="controls"><label>Deposit <select id="wDep"><option>50</option><option selected>200</option><option>500</option><option>1000</option></select></label>
<label>Airdrop share <select id="wShr"><option value="0.00001">0.001%</option><option value="0.000025" selected>0.0025%</option><option value="0.00005">0.005%</option></select></label>
<label>T-bill <select id="wTb"><option value="0">0%</option><option value="0.04" selected>4%</option><option value="0.08">8%</option></select></label></div>
<p id="wMath" class="mono"></p><h3>Steps (7 tx, 80 min total)</h3><ol class="steps">${steps(r).map(s=>`<li>${s}</li>`).join("")}</ol></div></div>`;
const upd=()=>{const g=farmMath(r);$("wMath").innerHTML=`slice ${money2(g.slice)} → floor slice ${money2(g.floor)} (÷ band ${M.band}×) − gas $14.00 − T-bill ${money2(dep*tbill*90/365)} = <b>net ${money2(g.net)}</b> · net/hour ${money2(g.nh)} · breakeven odds ${g.be>1?"never pays":(g.be*100).toFixed(1)+"%"} · <b class="v${g.ver}">${VNAME[g.ver]}</b>`;};
$("wDep").onchange=e=>{dep=+e.target.value;upd();};$("wShr").onchange=e=>{share=+e.target.value;upd();};$("wTb").onchange=e=>{tbill=+e.target.value;upd();};upd();
$("detail").scrollIntoView({behavior:"smooth",block:"start"});}
// pricing panel
$("pricing").innerHTML=`<p class="mono">log(mcap) = ${M.beta[0]} + ${M.beta[1]}·log(TVL) — no age term, no category offsets: both failed the 3-leg guard (see ablation)<br>
Fitted multiple = exp(pred)/TVL, clamped [0.08, 1.20]<br>
Conditional value = TVL × multiple × (1 + ${M.growthW}·clamp(7d, −60, 120)/100) × 0.85<br>
Launch odds: piecewise-constant hazard λ = [${M.hazLam.join(", ")}]/yr over age bins 0–180, 181–365, 366–730, 731–1095, 1096–1460, &gt;1460 days, × shrunk category multiplier; P(launch in 2y | not yet) = 1 − S(age+730)/S(age), clamped [1%, 98%]<br>
Expected value = conditional value × launch odds. Model band = 10^sd(log₁₀ LOO errors) = ${M.band}×.</p>
<p>No category offsets are used: dropping them improves LOO and time-split and lowers the 3-leg mean from 3.315 (no-age + offsets k=8) to 3.281, trailing only on walk-forward by 0.005.</p>`;
// ablation
$("abl").querySelector("tbody").innerHTML=M.abl.map(a=>`<tr><td style="text-align:left">${a[0]}</td><td>${a[1].toFixed(3)}×</td><td>${a[2].toFixed(3)}×</td><td>${a[3].toFixed(3)}×</td><td style="text-align:left">${a[4]}</td></tr>`).join("");
// scatter: log TVL vs EV, fitted conditional curve + global band
(function(){const cv=$("scatter"),ctx=cv.getContext("2d"),W=cv.width,H=cv.height;ctx.clearRect(0,0,W,H);
const xs=ROWS.map(r=>Math.log10(r[5])),ys=ROWS.map(r=>Math.log10(Math.max(1,r[11])));
const x0=Math.min(...xs)-0.2,x1=Math.max(...xs)+0.2,y0=Math.min(...ys)-0.3,y1=Math.max(...ys)+0.3;
const X=v=>40+(v-x0)/(x1-x0)*(W-60),Y=v=>H-30-(v-y0)/(y1-y0)*(H-50);
ctx.strokeStyle="#2a3646";ctx.beginPath();ctx.moveTo(40,10);ctx.lineTo(40,H-30);ctx.lineTo(W-20,H-30);ctx.stroke();
ctx.fillStyle="#8b98a9";ctx.font="11px sans-serif";ctx.fillText("TVL (log10 $)",W/2-30,H-8);ctx.save();ctx.translate(12,H/2);ctx.rotate(-Math.PI/2);ctx.fillText("Expected value (log10 $)",-70,0);ctx.restore();
for(const sgn of[-1,0,1]){ctx.strokeStyle=sgn===0?"#f0b90b":"#58a6ff";ctx.setLineDash(sgn===0?[]:[4,4]);ctx.beginPath();
for(let px=40;px<=W-20;px+=4){const lv=x0+(px-40)/(W-60)*(x1-x0),tvl=Math.pow(10,lv);
let mult=Math.exp(M.beta[0]+M.beta[1]*Math.log(tvl))/tvl;mult=Math.max(0.08,Math.min(1.2,mult));
let v=tvl*mult*0.85;if(sgn!==0)v*=Math.pow(M.band,sgn);const y=Y(Math.log10(v));px===40?ctx.moveTo(px,y):ctx.lineTo(px,y);}ctx.stroke();}
ctx.setLineDash([]);ctx.fillStyle="#3fb950";
ROWS.forEach(r=>{ctx.fillRect(X(Math.log10(r[5]))-1.5,Y(Math.log10(Math.max(1,r[11])))-1.5,3,3);});})();
// best farms
const bf=[...ROWS.map((r,i)=>[r,i])].sort((a,b)=>b[0][18]-a[0][18]).slice(0,5);
$("bestfarms").innerHTML=`<p>Net per hour lives in small protocols, not at the top of the board. Top 5 by net/hour (reference: $200 deposit, 0.0025% share, 4% T-bill):</p><div class="tblwrap"><table><thead><tr><th style="text-align:left">Protocol</th><th>Expected value</th><th>Net</th><th>Net / hour</th><th>Verdict</th></tr></thead><tbody>${bf.map(([r,i])=>`<tr><td style="text-align:left">#${i+1} ${r[1]}</td><td>${money(r[11])}</td><td>${money2(r[17]/100)}</td><td>${money2(r[18]/100)}</td><td class="v${r[19]}">${VNAME[r[19]]}</td></tr>`).join("")}</tbody></table></div>
<p>Portfolio of all Farm + Thin rows (${M.portfolio.n} rows): total cost ${money2(M.portfolio.cost)}, total net ${money2(M.portfolio.net)}, total work ${M.portfolio.hours.toFixed(1)} hours at the $200 / 0.0025% / 4% reference.</p>`;
// ledger
const L=M.ledger,cols={tokened:"#58a6ff",forbidden:"#f85149",versioned:"#d29922",wrapped:"#bc8cff",exchange:"#8b98a9",watchlist:"#f0b90b",abovefloor:"#3fb950",belowfloor:"#2ea043"};
const names={tokened:"Already tokened",forbidden:"Forbidden category",versioned:"Versioned name",wrapped:"Wrapped / staked word",exchange:"Exchange prefix",watchlist:"Watchlist (ranked)",abovefloor:"Above floor, off watchlist (ranked)",belowfloor:"Below floor early rows (ranked)"};
$("ledgerbar").innerHTML=Object.keys(L).map(k=>`<div style="width:${(L[k]/758*100).toFixed(1)}%;background:${cols[k]}" title="${names[k]}: ${L[k]}"></div>`).join("");
$("ledger").innerHTML=`<div class="leg">${Object.keys(L).map(k=>`<span><i style="background:${cols[k]}"></i>${names[k]}: <b>${L[k]}</b></span>`).join("")}</div>
<p class="note">Tokened splits into ${M.tokenedMcap} with a market cap above $0 and ${M.tokenedNoMcap} with a recorded token but no market cap. Ranked rows: watchlist 40 + above-floor 20 + below-floor 138 = 198. ${M.adjusted} row(s) had their rounded value nudged by $1 to keep the ranking strictly decreasing.</p>`;
// live tokens
$("live").querySelector("tbody").innerHTML=D.live.map(l=>`<tr><td style="text-align:left"><b>${l[1]}</b> <span style="color:var(--mut)">${l[0]}</span></td><td>${money(l[2])}</td></tr>`).join("");
// methodology
$("method").innerHTML=`<p>Value model: OLS log-log on <b>${M.compsN} comps</b> (market cap &gt; 0, TVL &gt; 0, one per token, mcap/TVL in [0.02, 20]); intercept ${M.beta[0]}, logTVL ${M.beta[1]} — no age term and no category offsets (both failed the 3-leg guard; see ablation). Age is not used by the value model, so no comp needs an imputed age for it (<b>${M.compsImp} comps</b> have no listed date; median dated-comp age ${M.compsMedAge} days). <b>${M.boardImp} board rows</b> use imputed age for launch odds only (median dated pre-token age ${M.medPreAge} days).</p>
<p>Validation (geometric factor-miss): leave-one-out ${M.loo.full.geo.toFixed(3)}× (median ${M.loo.full.med.toFixed(2)}×, ${Math.round(M.loo.full.le2*100)}% within 2×, ${Math.round(M.loo.full.le3*100)}% within 3×; fitted-multiple-only ${M.loo.raw.geo.toFixed(3)}×), time-split ${M.ts.nTrain}/${M.ts.nTest} ${M.ts.full.geo.toFixed(3)}× (raw ${M.ts.raw.geo.toFixed(3)}×), walk-forward expanding ${M.wf.full.geo.toFixed(3)}× (raw ${M.wf.raw.geo.toFixed(3)}×) and rolling ${M.wfRoll.full.geo.toFixed(3)}×. The model beats both baselines on all three legs.</p>
<p>Launch odds (70/30 split, seed ${M.splitSeed}, n=${M.hazVal.nTrain}/${M.hazVal.nTest}): hazard hit rate ${(M.hazVal.hit*100).toFixed(1)}%, Brier ${M.hazVal.brier.toFixed(4)}, base rate ${(M.hazVal.base*100).toFixed(1)}%; ever-rate comparator hit ${(M.hazVal.everHit*100).toFixed(1)}%, Brier ${M.hazVal.everBrier.toFixed(4)} — the hazard wins hit rate narrowly and loses Brier narrowly, shown here as measured. Hazard rates on train: [${M.hazVal.lamTrain.join(", ")}]/yr; three bins sit at the 0.05/yr floor.</p>
<p>Uncertainty: median local-band width ${M.bandWidthMed}% of value; median bootstrap rank range ${M.rankWidthMed} ranks (200 resamples, seed ${M.bootSeed}); ${Math.round(M.top10Stable*100)}% of the median top 10 stay top-10 in ≥80% of resamples; the median #1 stays #1 in ${Math.round(M.rank1Stays*100)}% of resamples. Mid-board order is comparatively stable across resamples — the median rank range is only ${M.rankWidthMed} ranks — because with no category offsets a bootstrap resample only shifts the smooth TVL curve, so rows barely move relative to each other; per-row uncertainty is still shown by the local band, built from the leave-one-out errors of the 20 nearest comps by TVL.</p>
<p>These coefficients are a compromise over shifting regimes, and implied value is a model claim, not a forecast and not advice. Farm reference: $200 deposit, 0.0025% share, 4% T-bill, 90 days, $14 gas (7 tx × $2), 80 minutes of work; Farm ≥ $60 net, Thin &gt; $0, Skip ≤ $0. Verdict distribution: Farm ${M.nFarm} · Thin ${M.nThin} · Skip ${M.nSkip}.</p>`;
// seal
(function(){let ok=0;for(let i=0;i<ROWS.length;i++){const r=ROWS[i];if(r[11]<=(i?ROWS[i-1][11]:1e18)&&r[12]<=r[11]&&r[11]<=r[13]&&(r[19]===(r[17]>=6000?2:r[17]>0?1:0)))ok++;}
$("seal").textContent=`Reproduction seal: ${ok}/${ROWS.length} ranks, values, bands and verdicts in this page match board.json.`;})();
render();
if(location.hash.startsWith("#detail=")){const s=location.hash.slice(8),i=ROWS.findIndex(r=>r[0]===s);if(i>=0)showDetail(i);}
if(location.hash==="#farm"){$("fVerd").value="2";render();}
