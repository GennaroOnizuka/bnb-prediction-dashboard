const CONFIG = window.DASHBOARD_CONFIG;

let pnlChart;

function $(id) {
  return document.getElementById(id);
}

function setError(message) {
  $("error").textContent = message || "";
}

function fmtBnb(value, digits = 5) {
  if (!Number.isFinite(value)) return "--";
  const sign = value >= 0 ? "" : "-";
  return `${sign}${Math.abs(value).toFixed(digits)} BNB`;
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function pnlClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function tradeDate(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function fetchSnapshot() {
  const response = await fetch(`${CONFIG.dataUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Dati non disponibili: HTTP ${response.status}`);
  }
  return response.json();
}

function renderKpis(snapshot) {
  const summary = snapshot.summary || {};
  const bnbUsd = Number(snapshot.bnbUsd || 0);
  const netBnb = Number(summary.netBnb || 0);
  const netUsd = Number.isFinite(Number(summary.netUsd)) ? Number(summary.netUsd) : netBnb * bnbUsd;

  $("netPnl").textContent = bnbUsd ? fmtUsd(netUsd) : "--";
  $("netPnl").className = pnlClass(netBnb);
  $("winRate").textContent = `${fmtPct(Number(summary.winRate || 0))}`;
  $("closedTrades").textContent = String(summary.closedCount || 0);
  $("openBets").textContent = String(summary.open || 0);
  $("volume").textContent = bnbUsd
    ? `Volume ${fmtUsd(Number(summary.volumeUsd || 0)).replace("+", "")}`
    : `Volume ${fmtBnb(Number(summary.volumeBnb || 0))}`;
  $("lossStreak").textContent = `Max loss streak ${summary.maxLossStreak || 0}`;
}

function renderChart(snapshot) {
  const summary = snapshot.summary || {};
  const bnbUsd = Number(snapshot.bnbUsd || 0);
  const days = summary.byDay || [];
  const labels = days.map((d) => d.day);
  const values = days.map((d) => bnbUsd ? Number(d.pnlBnb || 0) * bnbUsd : Number(d.pnlBnb || 0));

  pnlChart?.destroy();
  pnlChart = new Chart($("pnlChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: bnbUsd ? "Net PnL USD" : "Net PnL BNB",
        data: values,
        borderRadius: 5,
        backgroundColor: values.map((v) => v >= 0 ? "rgba(73, 216, 170, 0.86)" : "rgba(255, 107, 134, 0.86)")
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 150,
      plugins: {
        legend: { display: false },
        tooltip: { intersect: false, mode: "index" }
      },
      scales: {
        x: {
          ticks: { color: "#8aa19a" },
          grid: { display: false }
        },
        y: {
          ticks: { color: "#8aa19a" },
          grid: { color: "rgba(32,59,52,0.42)" }
        }
      }
    }
  });
}

function renderTrades(snapshot) {
  const bnbUsd = Number(snapshot.bnbUsd || 0);
  const rows = [...(snapshot.rows || [])]
    .sort((a, b) => Number(b.date_ms || 0) - Number(a.date_ms || 0))
    .slice(0, 10);

  const list = $("tradeList");
  list.innerHTML = "";

  if (!rows.length) {
    list.innerHTML = '<div class="trade-row"><div class="trade-main">Nessun trade disponibile.</div></div>';
    return;
  }

  for (const row of rows) {
    const netBnb = Number(row.netPnlBnb || 0);
    const netUsd = bnbUsd ? netBnb * bnbUsd : null;
    const side = String(row.direction || "").toLowerCase();
    const status = String(row.status || "OPEN");
    const statusClass = status === "WIN" ? "win" : status === "LOSS" ? "loss" : "";
    const link = row.txHash ? `https://bscscan.com/tx/${row.txHash}` : "";
    const node = document.createElement(link ? "a" : "div");
    if (link) {
      node.href = link;
      node.target = "_blank";
      node.rel = "noreferrer";
    }
    node.className = "trade-row";
    node.innerHTML = `
      <div class="trade-side ${side}">${row.direction || "--"}</div>
      <div class="trade-main">
        <div class="trade-title">
          <strong>Epoch ${row.epoch || "--"}</strong>
          <span class="wallet-badge">${row.module || "Wallet"}</span>
          <span class="trade-result ${statusClass}">${status}</span>
        </div>
        <div class="trade-meta">${tradeDate(row.date_ms)} · ${fmtBnb(Number(row.amountBnb || 0), 6)}</div>
      </div>
      <div class="trade-pnl ${pnlClass(netBnb)}">${netUsd === null ? fmtBnb(netBnb) : fmtUsd(netUsd)}</div>
    `;
    list.appendChild(node);
  }
}

function renderUpdatedAt(snapshot) {
  const generated = snapshot.generated_ms ? new Date(snapshot.generated_ms) : null;
  const bnbUsd = snapshot.bnbUsd ? `$${Number(snapshot.bnbUsd).toFixed(2)}` : "BNB n/d";
  $("updatedAt").textContent = generated
    ? `Aggiornato ${generated.toLocaleString("it-IT")} · BNB ${bnbUsd}`
    : `Aggiornamento non disponibile · BNB ${bnbUsd}`;
}

async function refresh() {
  setError("");
  try {
    const snapshot = await fetchSnapshot();
    renderUpdatedAt(snapshot);
    renderKpis(snapshot);
    renderChart(snapshot);
    renderTrades(snapshot);
  } catch (error) {
    setError(error?.message || String(error));
  }
}

$("refresh").addEventListener("click", refresh);
refresh();
