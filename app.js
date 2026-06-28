const CONFIG = window.DASHBOARD_CONFIG;

const ABI = [
  "event BetBull(address indexed sender,uint256 indexed epoch,uint256 amount)",
  "event BetBear(address indexed sender,uint256 indexed epoch,uint256 amount)",
  "event Claim(address indexed sender,uint256 indexed epoch,uint256 amount)",
  "function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)",
  "function currentEpoch() view returns (uint256)"
];

let pnlChart;
let outcomeChart;

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, mode = "") {
  const node = $("status");
  node.textContent = text;
  node.className = `status-pill ${mode}`;
}

function setError(message) {
  $("error").textContent = message || "";
}

function fmtBnb(value, digits = 5) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(digits)} BNB`;
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function shortAddress(address) {
  if (!address) return "--";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function nsToDate(tsNs) {
  return new Date(Number(BigInt(tsNs) / 1000000n));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function bnb(valueWei) {
  return Number(ethers.formatEther(valueWei || 0n));
}

function receiptGasBnb(receipt) {
  if (!receipt) return 0;
  const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice || 0n;
  return bnb(receipt.gasUsed * gasPrice);
}

function paddedAddressTopic(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

async function createProvider() {
  let lastError;
  for (const url of CONFIG.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, CONFIG.chainId, { staticNetwork: true });
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No BSC RPC available");
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask non trovato. Apri il link nel browser MetaMask oppure incolla l'indirizzo wallet.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("Nessun account MetaMask disponibile.");
  return ethers.getAddress(accounts[0]);
}

async function fetchBnbUsd() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { cache: "no-store" });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const payload = await res.json();
    const price = Number(payload.price);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const out = [];
  const step = CONFIG.maxChunkBlocks;
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = Math.min(start + step - 1, toBlock);
    const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    out.push(...logs);
    setStatus(`Sync ${Math.round(((end - fromBlock) / Math.max(1, toBlock - fromBlock)) * 100)}%`, "warn");
  }
  return out;
}

async function fetchOnchain(wallet, days) {
  const provider = await createProvider();
  const contract = new ethers.Contract(CONFIG.predictionContract, ABI, provider);
  const iface = new ethers.Interface(ABI);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(1, latest - Math.ceil(days * CONFIG.blocksPerDay));
  const senderTopic = paddedAddressTopic(wallet);

  const betBullTopic = iface.getEvent("BetBull").topicHash;
  const betBearTopic = iface.getEvent("BetBear").topicHash;
  const claimTopic = iface.getEvent("Claim").topicHash;

  const [bullLogs, bearLogs, claimLogs, bnbUsd] = await Promise.all([
    getLogsChunked(provider, { address: CONFIG.predictionContract, topics: [betBullTopic, senderTopic] }, fromBlock, latest),
    getLogsChunked(provider, { address: CONFIG.predictionContract, topics: [betBearTopic, senderTopic] }, fromBlock, latest),
    getLogsChunked(provider, { address: CONFIG.predictionContract, topics: [claimTopic, senderTopic] }, fromBlock, latest),
    fetchBnbUsd()
  ]);

  const claimsByEpoch = new Map();
  for (const log of claimLogs) {
    const parsed = iface.parseLog(log);
    const epoch = parsed.args.epoch.toString();
    const amountBnb = bnb(parsed.args.amount);
    const receipt = await provider.getTransactionReceipt(log.transactionHash).catch(() => null);
    const gasBnb = receiptGasBnb(receipt);
    claimsByEpoch.set(epoch, {
      txHash: log.transactionHash,
      amountBnb,
      gasBnb
    });
  }

  const betLogs = [
    ...bullLogs.map((log) => ({ log, direction: "UP" })),
    ...bearLogs.map((log) => ({ log, direction: "DOWN" }))
  ].sort((a, b) => (a.log.blockNumber - b.log.blockNumber) || (a.log.index - b.log.index));

  const blockCache = new Map();
  async function blockDate(blockNumber) {
    if (!blockCache.has(blockNumber)) {
      blockCache.set(blockNumber, await provider.getBlock(blockNumber));
    }
    return new Date(Number(blockCache.get(blockNumber).timestamp) * 1000);
  }

  const roundCache = new Map();
  async function roundInfo(epoch) {
    if (!roundCache.has(epoch)) {
      roundCache.set(epoch, await contract.rounds(epoch).catch(() => null));
    }
    return roundCache.get(epoch);
  }

  const rows = [];
  for (const item of betLogs) {
    const parsed = iface.parseLog(item.log);
    const epoch = parsed.args.epoch.toString();
    const amountBnb = bnb(parsed.args.amount);
    const date = await blockDate(item.log.blockNumber);
    const receipt = await provider.getTransactionReceipt(item.log.transactionHash).catch(() => null);
    const betGasBnb = receiptGasBnb(receipt);
    const round = await roundInfo(epoch);
    let resultDirection = "OPEN";
    let status = "OPEN";
    let grossPnlBnb = 0;
    let payoutBnb = 0;
    let closePrice = null;
    let lockPrice = null;

    if (round && round.oracleCalled) {
      lockPrice = Number(round.lockPrice);
      closePrice = Number(round.closePrice);
      if (closePrice > lockPrice) resultDirection = "UP";
      else if (closePrice < lockPrice) resultDirection = "DOWN";
      else resultDirection = "DRAW";

      const won = resultDirection === item.direction;
      status = won ? "WIN" : "LOSS";
      if (won) {
        const claim = claimsByEpoch.get(epoch);
        if (claim) {
          payoutBnb = claim.amountBnb;
        } else if (round.rewardBaseCalAmount > 0n && round.rewardAmount > 0n) {
          payoutBnb = amountBnb * Number(round.rewardAmount) / Number(round.rewardBaseCalAmount);
          status = "WIN_UNCLAIMED";
        }
        grossPnlBnb = payoutBnb - amountBnb;
      } else {
        grossPnlBnb = -amountBnb;
      }
    }

    const claim = claimsByEpoch.get(epoch);
    const claimGasBnb = claim?.gasBnb || 0;
    const netPnlBnb = grossPnlBnb - betGasBnb - claimGasBnb;

    rows.push({
      epoch,
      date,
      direction: item.direction,
      resultDirection,
      status,
      amountBnb,
      payoutBnb,
      grossPnlBnb,
      gasBnb: betGasBnb + claimGasBnb,
      netPnlBnb,
      txHash: item.log.transactionHash,
      claimTxHash: claim?.txHash || "",
      lockPrice,
      closePrice
    });
  }

  return {
    wallet,
    latestBlock: latest,
    fromBlock,
    bnbUsd,
    rows
  };
}

function summarize(rows, bnbUsd) {
  const closed = rows.filter((r) => r.status !== "OPEN");
  const wins = closed.filter((r) => r.status.startsWith("WIN")).length;
  const losses = closed.filter((r) => r.status === "LOSS").length;
  const open = rows.length - closed.length;
  const netBnb = closed.reduce((acc, r) => acc + r.netPnlBnb, 0);
  const grossBnb = closed.reduce((acc, r) => acc + r.grossPnlBnb, 0);
  const gasBnb = closed.reduce((acc, r) => acc + r.gasBnb, 0);
  const volumeBnb = rows.reduce((acc, r) => acc + r.amountBnb, 0);
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;

  let streak = 0;
  let maxLossStreak = 0;
  for (const r of closed) {
    if (r.status === "LOSS") {
      streak += 1;
      maxLossStreak = Math.max(maxLossStreak, streak);
    } else if (r.status.startsWith("WIN")) {
      streak = 0;
    }
  }

  const byDay = new Map();
  for (const r of closed) {
    const key = dateKey(r.date);
    const item = byDay.get(key) || { day: key, pnlBnb: 0, trades: 0, wins: 0, losses: 0 };
    item.pnlBnb += r.netPnlBnb;
    item.trades += 1;
    if (r.status.startsWith("WIN")) item.wins += 1;
    if (r.status === "LOSS") item.losses += 1;
    byDay.set(key, item);
  }

  return {
    closedCount: closed.length,
    totalCount: rows.length,
    wins,
    losses,
    open,
    winRate,
    netBnb,
    netUsd: bnbUsd ? netBnb * bnbUsd : null,
    grossBnb,
    gasBnb,
    volumeBnb,
    volumeUsd: bnbUsd ? volumeBnb * bnbUsd : null,
    maxLossStreak,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  };
}

function renderCards(summary, bnbUsd, wallet) {
  const netClass = summary.netBnb > 0 ? "positive" : summary.netBnb < 0 ? "negative" : "neutral";
  $("netPnl").textContent = bnbUsd ? `${fmtUsd(summary.netUsd)} / ${fmtBnb(summary.netBnb)}` : fmtBnb(summary.netBnb);
  $("netPnl").className = `card-value ${netClass}`;
  $("winRate").textContent = `${fmtPct(summary.winRate)} (${summary.wins}/${summary.closedCount})`;
  $("openBets").textContent = String(summary.open);
  $("lossStreak").textContent = String(summary.maxLossStreak);
  $("volume").textContent = bnbUsd ? `$${summary.volumeUsd.toFixed(2)}` : fmtBnb(summary.volumeBnb);
  $("walletShort").textContent = shortAddress(wallet);
}

function renderCharts(summary, bnbUsd) {
  const labels = summary.byDay.map((d) => d.day);
  const pnlValues = summary.byDay.map((d) => bnbUsd ? d.pnlBnb * bnbUsd : d.pnlBnb);
  const winValues = summary.byDay.map((d) => d.wins);
  const lossValues = summary.byDay.map((d) => d.losses);

  pnlChart?.destroy();
  pnlChart = new Chart($("pnlChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: bnbUsd ? "Net PnL USD" : "Net PnL BNB",
        data: pnlValues,
        backgroundColor: pnlValues.map((v) => v >= 0 ? "rgba(72, 215, 170, 0.8)" : "rgba(255, 109, 138, 0.8)")
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e8f3ef" } } },
      scales: {
        x: { ticks: { color: "#8da19b" }, grid: { color: "rgba(35,65,58,0.35)" } },
        y: { ticks: { color: "#8da19b" }, grid: { color: "rgba(35,65,58,0.35)" } }
      }
    }
  });

  outcomeChart?.destroy();
  outcomeChart = new Chart($("outcomeChart"), {
    type: "doughnut",
    data: {
      labels: ["Win", "Loss"],
      datasets: [{
        data: [summary.wins, summary.losses],
        backgroundColor: ["#48d7aa", "#ff6d8a"],
        borderColor: "#0d1a17"
      }]
    },
    options: {
      plugins: { legend: { labels: { color: "#e8f3ef" } } }
    }
  });
}

function renderTable(rows, bnbUsd) {
  const tbody = $("tradesBody");
  tbody.innerHTML = "";
  const sorted = [...rows].sort((a, b) => b.date - a.date).slice(0, 80);
  for (const row of sorted) {
    const tr = document.createElement("tr");
    const pnl = bnbUsd ? row.netPnlBnb * bnbUsd : row.netPnlBnb;
    const pnlText = bnbUsd ? fmtUsd(pnl) : fmtBnb(pnl);
    const pnlClass = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
    tr.innerHTML = `
      <td>${row.date.toLocaleString()}</td>
      <td>${row.epoch}</td>
      <td><span class="tag ${row.direction.toLowerCase()}">${row.direction}</span></td>
      <td><span class="tag ${row.status.toLowerCase().replace("_unclaimed", " open")}">${row.status}</span></td>
      <td>${fmtBnb(row.amountBnb, 6)}</td>
      <td class="${pnlClass}">${pnlText}</td>
      <td>${fmtBnb(row.gasBnb, 6)}</td>
      <td>${row.resultDirection}</td>
      <td><a href="https://bscscan.com/tx/${row.txHash}" target="_blank" rel="noreferrer">tx</a></td>
    `;
    tbody.appendChild(tr);
  }
}

async function refresh() {
  setError("");
  try {
    const wallet = ethers.getAddress($("wallet").value.trim());
    const days = Number($("days").value || CONFIG.defaultDays);
    localStorage.setItem("bnb-dashboard-wallet", wallet);
    setStatus("Sync...", "warn");
    const payload = await fetchOnchain(wallet, days);
    const summary = summarize(payload.rows, payload.bnbUsd);
    renderCards(summary, payload.bnbUsd, wallet);
    renderCharts(summary, payload.bnbUsd);
    renderTable(payload.rows, payload.bnbUsd);
    $("lastUpdate").textContent = `Ultimo refresh: ${new Date().toLocaleString()} | blocchi ${payload.fromBlock}-${payload.latestBlock} | BNB ${payload.bnbUsd ? `$${payload.bnbUsd.toFixed(2)}` : "USD n/d"}`;
    setStatus("Online", "ok");
  } catch (error) {
    console.error(error);
    setStatus("Errore", "");
    setError(error?.message || String(error));
  }
}

async function main() {
  $("wallet").value = localStorage.getItem("bnb-dashboard-wallet") || CONFIG.defaultWallet || "";
  $("days").value = String(CONFIG.defaultDays);
  $("refresh").addEventListener("click", refresh);
  $("connect").addEventListener("click", async () => {
    setError("");
    try {
      $("wallet").value = await connectWallet();
      await refresh();
    } catch (error) {
      setError(error?.message || String(error));
    }
  });
  if ($("wallet").value) {
    await refresh();
  }
}

main();
