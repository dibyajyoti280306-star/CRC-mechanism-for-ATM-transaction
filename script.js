// ===================================================
//  ATM Transaction & CRC Error Detection Simulator
//  script.js  (ATM / client side)
// ===================================================

const GENERATOR = "1000111";              // x^6 + x^2 + x + 1
const CRC_BITS = GENERATOR.length - 1;    // 6 CRC bits

const ERROR_NAMES = {
  NONE: "No Error",
  SINGLE: "Single-Bit Error",
  MULTIPLE: "Multiple-Bit Error",
  BURST: "Burst Error"
};
const TYPE_NAMES = { WITHDRAW: "Withdrawal", DEPOSIT: "Deposit" };

// Session data (lost when the page is reloaded)
let currentTxn = null;
let txnCounter = 0;
let isSending = false;
let stats = {
  NONE:     { runs: 0, detected: 0, notDetected: 0 },
  SINGLE:   { runs: 0, detected: 0, notDetected: 0 },
  MULTIPLE: { runs: 0, detected: 0, notDetected: 0 },
  BURST:    { runs: 0, detected: 0, notDetected: 0 }
};

// Keep history and analysis after a page refresh
const STORE_KEY = "atmCrcSession";
let historyRows = [];

function saveSession() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      txnCounter: txnCounter,
      stats: stats,
      rows: historyRows
    }));
  } catch (e) {}
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!saved) return;
    txnCounter = saved.txnCounter || 0;
    stats = saved.stats || stats;
    historyRows = saved.rows || [];
    if (historyRows.length) {
      if ($("historyEmpty")) $("historyEmpty").remove();
      $("historyBody").insertAdjacentHTML("beforeend", historyRows.join(""));
      $("historyCount").textContent = historyRows.length;
    }
  } catch (e) {}
}


// ---------- Small helper functions ----------

function $(id) {
  return document.getElementById(id);
}

// Makes text safe to place inside HTML
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Random whole number from min to max (both included)
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Waits for some milliseconds (used for the transmission animation)
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Reads a whole number from text. Returns NaN if it is not a whole number.
function toInt(value) {
  const text = String(value).trim();
  return /^[0-9]+$/.test(text) ? parseInt(text, 10) : NaN;
}

// Value of the selected radio button in a group
function getRadio(name) {
  return document.querySelector('input[name="' + name + '"]:checked').value;
}

// Text -> bits (8 bits per character, ASCII)
function textToBinary(text) {
  let bits = "";
  for (let i = 0; i < text.length; i++) {
    bits += text.charCodeAt(i).toString(2).padStart(8, "0");
  }
  return bits;
}

// Bits -> text (8 bits per character)
function binaryToText(bits) {
  let text = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    text += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
  }
  return text;
}

// Shows bits in groups of 8 so they are easy to read
function groupBits(bits) {
  return bits.match(/.{1,8}/g).join(" ");
}

// Shows a character safely (strange characters become a replacement symbol)
function showChar(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 32 && code <= 126) ? esc(ch) : "&#65533;";
}

// Wraps content in the monospace bit box
function mono(html) {
  return '<div class="bitbox">' + html + "</div>";
}

// Draws any <i data-lucide="..."> icons that were added after page load
function refreshIcons() {
  if (typeof lucide !== "undefined") {
    lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
  }
}


// ---------- Screen state helpers ----------

// Progress tracker at the top.
// current = 1 (create), 2 (transmit), 3 (verify). result = "ok" | "bad" | "warn" (step 3 only)
function setStage(current, result) {
  document.querySelectorAll("#steps li").forEach(function (li) {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < current);
    li.classList.toggle("current", n === current);
    li.classList.remove("ok", "bad", "warn");
    if (n === 3 && n === current && result) li.classList.add(result);
  });
}

// Shows the bank result, or the "waiting" message in its place
function showBank(show) {
  $("bankScreen").hidden = !show;
  $("bankIdle").hidden = show;
}

function setBankIdle(title, text, isError) {
  $("bankIdleTitle").textContent = title;
  $("bankIdleText").textContent = text;
  $("bankIdle").classList.toggle("error", !!isError);
}

function setChannel(state, noise, text) {
  const link = $("link");
  link.dataset.noise = noise ? "1" : "0";
  link.dataset.state = state;
  $("linkText").textContent = text;
}

function showFormError(message) {
  $("formError").textContent = message;
}

// The one-line story under the progress tracker
function tell(text, tone) {
  $("story").dataset.tone = tone || "";
  const p = $("storyText");
  p.textContent = text;
  p.classList.remove("swap");
  void p.offsetWidth;                     // restarts the fade
  p.classList.add("swap");
}

// Small status chip in the header of the ATM or bank panel
function setStatus(which, text, cls) {
  const el = $(which === "atm" ? "atmStatus" : "bankStatus");
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}


// ---------- CRC (modulo-2 division) ----------

// Divides the bits by the generator.
// Returns the remainder, the first 5 steps and the total number of XOR steps.
function crcDivisionDetailed(bits) {
  const arr = bits.split("").map(Number);
  const gen = GENERATOR.split("").map(Number);
  const steps = [];
  let xorCount = 0;

  for (let i = 0; i <= arr.length - gen.length; i++) {
    if (arr[i] === 1) {
      const before = arr.slice(i, i + gen.length).join("");
      for (let j = 0; j < gen.length; j++) {
        arr[i + j] ^= gen[j];            // XOR = modulo-2 subtraction
      }
      const after = arr.slice(i, i + gen.length).join("");
      xorCount++;
      if (steps.length < 5) {
        steps.push("Step " + xorCount + " (at bit " + (i + 1) + "): " +
                   before + " XOR " + GENERATOR + " = " + after);
      }
    }
  }

  return {
    remainder: arr.slice(arr.length - CRC_BITS).join(""),
    steps: steps,
    xorCount: xorCount
  };
}

// Returns only the remainder (6 bits)
function crcDivision(bits) {
  return crcDivisionDetailed(bits).remainder;
}

// Builds the codeword: data bits + CRC remainder
function generateCRC(dataBits) {
  const augmented = dataBits + "0".repeat(CRC_BITS);   // add 6 zeros
  const detail = crcDivisionDetailed(augmented);
  return {
    augmented: augmented,
    remainder: detail.remainder,
    codeword: dataBits + detail.remainder,
    steps: detail.steps,
    xorCount: detail.xorCount
  };
}


// ---------- Showing bits with highlights ----------

// flipped = Set of changed bit positions (0-based) or null
// markTail = true colours the last 6 bits (the CRC part) green
function renderBits(bits, flipped, markTail) {
  const dataLen = bits.length - CRC_BITS;
  let html = "";

  for (let i = 0; i < bits.length; i++) {
    if (i > 0 && i < dataLen && i % 8 === 0) html += '<span class="gap"></span>';
    if (i === dataLen) html += '<span class="sep">|</span>';

    let cls = "";
    if (flipped && flipped.has(i)) cls = "bit flip";
    else if (markTail && i >= dataLen) cls = "bit crc";

    html += cls ? '<span class="' + cls + '">' + bits[i] + "</span>" : bits[i];
  }
  return mono(html);
}

// Shows the received characters, with changed ones in red
function diffHtml(original, received) {
  let html = "";
  for (let i = 0; i < received.length; i++) {
    html += original[i] === received[i]
      ? showChar(received[i])
      : '<span class="diff">' + showChar(received[i]) + "</span>";
  }
  return html;
}

// Describes which bits were changed (1-based positions)
function describeChange(typeKey, positions) {
  if (positions.length === 0) return "None";
  if (typeKey === "BURST") {
    return (positions[0] + 1) + "&ndash;" + (positions[positions.length - 1] + 1) +
           " (" + positions.length + " bits)";
  }
  const list = positions.slice(0, 20).map(function (p) { return p + 1; }).join(", ");
  return list + (positions.length > 20 ? ", ..." : "");
}


// ---------- Step 1: Generate Transaction (ATM screen) ----------

function generateTransaction() {
  const accId = $("accId").value.trim().toUpperCase();
  const txnType = $("txnType").value;
  const amount = $("amount").value.trim();

  showFormError("");

  // Input checks
  if (!/^[A-Z0-9]+$/.test(accId)) {
    showFormError("Account ID must have only letters and numbers (example: ACC1023).");
    $("accId").focus();
    return;
  }
  if (!/^[0-9]+$/.test(amount) || parseInt(amount, 10) <= 0) {
    showFormError("Amount must be a whole number greater than 0.");
    $("amount").focus();
    return;
  }

  // Remember the account ID for the suggestion list
  const known = Array.from($("accountHistory").options).some(function (o) {
    return o.value === accId;
  });
  if (!known) {
    const opt = document.createElement("option");
    opt.value = accId;
    $("accountHistory").appendChild(opt);
  }

  // Readable data -> binary -> CRC codeword
  const dataText = accId + "|" + txnType + "|" + amount;
  const binary = textToBinary(dataText);
  const crc = generateCRC(binary);
  const check = crcDivision(crc.codeword);          // must be 000000

  currentTxn = {
    accId: accId,
    txnType: txnType,
    amount: amount,
    dataText: dataText,
    binary: binary,
    remainder: crc.remainder,
    codeword: crc.codeword
  };

  // A new transaction clears the old bank result and resets the channel
  setChannel("idle", false, "Channel idle");
  showBank(false);
  setBankIdle("Waiting for transmission", "Transaction ready", false);
  $("bankReceived").innerHTML = "";
  $("bankSummary").innerHTML = "";
  $("finalBanner").innerHTML = "";
  $("receivedBits").innerHTML = "";
  $("verification").innerHTML = "";

  // Short summary (always visible)
  $("summaryTxn").innerHTML =
    '<p class="sub-title">Transaction fields</p>' +
    '<table class="kv">' +
    "<tr><th>Account ID</th><td>" + esc(accId) + "</td></tr>" +
    "<tr><th>Transaction type</th><td>" + TYPE_NAMES[txnType] + "</td></tr>" +
    "<tr><th>Amount</th><td>₹" + esc(amount) + "</td></tr>" +
    "<tr><th>Transaction data</th><td>" + esc(dataText) + "</td></tr>" +
    "</table>";

  $("summaryCrc").innerHTML =
    '<p class="sub-title">CRC parameters</p>' +
    '<table class="kv">' +
    "<tr><th>Data bits</th><td>" + binary.length + "</td></tr>" +
    "<tr><th>Generator polynomial</th><td>" + GENERATOR + "</td></tr>" +
    "<tr><th>CRC</th><td>" + crc.remainder + "</td></tr>" +
    "<tr><th>Codeword length</th><td>" + crc.codeword.length + " bits</td></tr>" +
    "</table>";

  // Details (hidden inside expandable sections)
  $("binaryData").innerHTML =
    "<p><b>Binary data (8 bits per character):</b></p>" + mono(groupBits(binary));

  $("crcCalc").innerHTML =
    "<p><b>Generator polynomial:</b> " + GENERATOR + " &nbsp;(x^6 + x^2 + x + 1)</p>" +
    "<p><b>Data + " + CRC_BITS + " zeros added (" + crc.augmented.length + " bits):</b></p>" +
    mono(groupBits(crc.augmented)) +
    "<p><b>First division steps:</b></p><pre>" + esc(crc.steps.join("\n")) +
    "\n... (" + crc.xorCount + " XOR steps in total)</pre>" +
    "<p><b>CRC remainder:</b> " + crc.remainder + "</p>" +
    "<p><b>Final codeword = data + CRC (" + crc.codeword.length + " bits):</b></p>" +
    renderBits(crc.codeword, null, true) +
    "<p>Self-check: dividing the codeword by the generator gives <b>" + check +
    (check === "0".repeat(CRC_BITS) ? " &#10003;" : " &#10007; (problem in the CRC code)") + "</b></p>";

  $("txnSummary").hidden = false;
  setStage(2);
  setStatus("atm", "Frame built", "ready");
  setStatus("bank", "Idle", "");
  tell("Codeword built: " + crc.codeword.length + " bits");
}


// ---------- Step 2: Initiate Transmission (pop-up) ----------

// Shows only the options that belong to the selected error type
function updateModalOptions() {
  const type = getRadio("errorType");
  $("singleOptions").hidden = type !== "SINGLE";
  $("multipleOptions").hidden = type !== "MULTIPLE";
  $("burstOptions").hidden = type !== "BURST";
  $("singleBitWrap").hidden = !(type === "SINGLE" && getRadio("singleMode") === "SELECT");
  $("burstStartWrap").hidden = !(type === "BURST" && getRadio("burstMode") === "SELECT");
}

// Puts the pop-up back to its default state (No Error selected)
function resetModal() {
  document.querySelector('input[name="errorType"][value="NONE"]').checked = true;
  document.querySelector('input[name="singleMode"][value="RANDOM"]').checked = true;
  document.querySelector('input[name="burstMode"][value="RANDOM"]').checked = true;
  $("singleBit").value = "";
  $("multipleCount").value = 3;
  $("burstStart").value = "";
  $("burstLength").value = 6;
  $("modalError").textContent = "";
  updateModalOptions();
}

function openModal() {
  resetModal();
  const n = currentTxn.codeword.length;
  $("modalBits").textContent = "Codeword: " + n + " bits (positions 1 to " + n + ")";
  $("modalBackdrop").hidden = false;
}

function closeModal() {
  $("modalBackdrop").hidden = true;
}

// Checks what the user typed in the pop-up. Returns { config } or { error }.
function validateConfig(typeKey) {
  const n = currentTxn.codeword.length;       // total number of bits
  const config = {};

  if (typeKey === "SINGLE") {
    config.singleMode = getRadio("singleMode");
    if (config.singleMode === "SELECT") {
      config.singleBit = toInt($("singleBit").value);
      if (!(config.singleBit >= 1 && config.singleBit <= n)) {
        return { error: "Bit position must be a whole number from 1 to " + n + "." };
      }
    }
  }

  if (typeKey === "MULTIPLE") {
    config.count = toInt($("multipleCount").value);
    if (!(config.count >= 2 && config.count <= n)) {
      return { error: "Number of bits must be a whole number from 2 to " + n + "." };
    }
  }

  if (typeKey === "BURST") {
    config.burstLength = toInt($("burstLength").value);
    if (!(config.burstLength >= 2 && config.burstLength <= n)) {
      return { error: "Burst length must be a whole number from 2 to " + n + "." };
    }
    config.burstMode = getRadio("burstMode");
    if (config.burstMode === "SELECT") {
      config.burstStart = toInt($("burstStart").value);
      const lastStart = n - config.burstLength + 1;
      if (!(config.burstStart >= 1 && config.burstStart <= lastStart)) {
        return {
          error: "For a burst of " + config.burstLength +
                 " bits, the starting position must be from 1 to " + lastStart + "."
        };
      }
    }
  }

  return { config: config };
}


// ---------- The channel: flipping bits ----------

// Flips bits in the codeword. Returns the new codeword and the changed positions (0-based).
function introduceError(codeword, type, config) {
  const n = codeword.length;
  const positions = new Set();

  if (type === "SINGLE") {
    if (config.singleMode === "SELECT") positions.add(config.singleBit - 1);
    else positions.add(randInt(0, n - 1));
  } else if (type === "MULTIPLE") {
    while (positions.size < config.count) positions.add(randInt(0, n - 1));
  } else if (type === "BURST") {
    const len = config.burstLength;
    const start = config.burstMode === "SELECT"
      ? config.burstStart - 1
      : randInt(0, n - len);
        for (let k = 0; k < len; k++) {
      const isEnd = k === 0 || k === len - 1;
      if (isEnd || !config.randomMiddle || Math.random() < 0.5) positions.add(start + k);
    }
  }

  const bits = codeword.split("");
  positions.forEach(function (p) {
    bits[p] = bits[p] === "0" ? "1" : "0";
  });

  return {
    transmitted: bits.join(""),
    positions: Array.from(positions).sort(function (a, b) { return a - b; })
  };
}


// ---------- Bank Server screen ----------

function renderReceived(txn, receivedText) {
  const fields = [
    ["Account ID", txn.accId],
    ["Transaction Type", txn.txnType],
    ["Amount (₹)", txn.amount]
  ];

  let rows = "";
  let start = 0;
  fields.forEach(function (f) {
    const sent = f[1];
    const got = receivedText.slice(start, start + sent.length);
    start += sent.length + 1;                 // +1 skips the "|" separator
    rows += "<tr><td>" + f[0] + "</td><td>" + esc(sent) +
            "</td><td>" + diffHtml(sent, got) + "</td></tr>";
  });

  rows += "<tr><td>Full data</td><td>" + esc(txn.dataText) +
          "</td><td>" + diffHtml(txn.dataText, receivedText) + "</td></tr>";

  $("bankReceived").innerHTML =
    '<table id="compareTable"><thead><tr><th>Field</th><th>Sent</th><th>Received</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table>";
}

function renderBankSummary(txn, typeKey, positions, data, totalBits) {
  const detected = data.crc_status === "ERROR_DETECTED";
  const ber = (positions.length / totalBits * 100).toFixed(2);

  const changed = positions.length === 0
    ? "None"
    : positions.length + " of " + totalBits + " bits (BER " + ber + "%) &mdash; positions " +
      describeChange(typeKey, positions);

  const result = detected
    ? '<span class="pill bad">Error detected</span>'
    : '<span class="pill ok">CRC verified</span>';

    $("bankSummary").innerHTML =
    '<div class="group">' +
    '<p class="sub-title">Sent by the ATM</p>' +
    '<table class="kv">' +
    "<tr><th>Data bits</th><td>" + txn.binary.length + "</td></tr>" +
    "<tr><th>Generator polynomial</th><td>" + GENERATOR + "</td></tr>" +
    "<tr><th>CRC sent by ATM</th><td>" + txn.remainder + "</td></tr>" +
    "<tr><th>Codeword length</th><td>" + totalBits + " bits</td></tr>" +
    "</table></div>" +
    '<div class="group">' +
    '<p class="sub-title">What the channel did</p>' +
    '<table class="kv">' +
    "<tr><th>Error type</th><td>" + ERROR_NAMES[typeKey] + "</td></tr>" +
    "<tr><th>Bits changed</th><td>" + changed + "</td></tr>" +
    "</table></div>" +
    '<div class="group">' +
    '<p class="sub-title">Bank check</p>' +
    '<table class="kv">' +
    "<tr><th>CRC remainder at bank</th><td>" + esc(data.remainder) + "</td></tr>" +
    "<tr><th>Verification result</th><td>" + result + "</td></tr>" +
    "</table></div>";
}

// Returns { cls, story, status } so the tracker, story line and bank chip match the banner
function renderFinalBanner(txn, positions, data) {
  const detected = data.crc_status === "ERROR_DETECTED";
  const injected = positions.length;
  const typeName = TYPE_NAMES[txn.txnType];
  let cls, icon, title, subtitle, note, story, status;

  if (detected && injected === 0) {
    cls = "warn";
    icon = "triangle-alert";
    title = "Unexpected result";
    subtitle = "Check the CRC code";
    note = "The ATM and bank CRC code do not agree. Check both CRC functions.";
    story = "Unexpected result";
    status = "Check CRC code";
  } else if (detected) {
    cls = "bad";
    icon = "shield-alert";
    title = "Error detected";
    subtitle = "Transaction rejected";
    note = "The corrupted transaction was caught before it was accepted.";
    story = "CRC mismatch, transaction rejected";
    status = "Rejected";
  } else if (injected > 0) {
    cls = "warn";
    icon = "triangle-alert";
    title = "Error not detected";
    subtitle = "CRC verified, but the data was corrupted";
    note = "This error pattern slipped past the CRC check. CRC is very strong, but not perfect.";
    story = "CRC matched, but the data was corrupted";
    status = "Accepted, data corrupted";
  } else {
    cls = "ok";
    icon = "shield-check";
    title = "CRC verified";
    subtitle = "Transaction accepted";
    note = typeName + " of ₹" + txn.amount + " processed successfully.";
    story = "CRC matched, transaction accepted";
    status = "Accepted";
  }

  $("finalBanner").innerHTML =
    '<div class="banner ' + cls + '">' +
    '<i data-lucide="' + icon + '"></i>' +
    "<div>" +
    "<h3>" + title + "</h3>" +
    "<p><b>" + subtitle + "</b></p>" +
    "</div>" +
    "</div>";

  return { cls: cls, story: story, status: status };
}

function renderBankDetails(received, flipSet, data) {
  $("receivedBits").innerHTML =
    "<p><b>Received codeword:</b></p>" + renderBits(received, flipSet, true) +
    '<p><small><span class="bit flip">red</span> = changed bit, ' +
    '<span class="bit crc">green</span> = CRC bits, | = where the data ends</small></p>';

  const steps = Array.isArray(data.division_steps) ? data.division_steps.join("\n") : "";
  $("verification").innerHTML =
    "<p><b>Generator polynomial:</b> " + GENERATOR + "</p>" +
    (steps ? "<p><b>CRC division (done by the bank server):</b></p><pre>" + esc(steps) + "</pre>" : "") +
    "<p><b>Remainder:</b> " + esc(data.remainder) + "</p>";
}


// ---------- Transaction History and CRC Analysis ----------

function addHistory(label, txn, typeKey, positions, data) {
  const detected = data.crc_status === "ERROR_DETECTED";
  let crcResult = '<span class="pill ok">Valid</span>';
  if (detected) crcResult = '<span class="pill bad">Error</span>';
  else if (positions.length > 0) crcResult = '<span class="pill warn">Valid (error missed)</span>';

  const status = data.transaction_status.charAt(0) +
                 data.transaction_status.slice(1).toLowerCase();
  const statusCls = /^accept/i.test(status) ? "ok" : "bad";

  const empty = $("historyEmpty");
  if (empty) empty.remove();

   const row =
    "<tr><td>" + label + "</td><td>" + TYPE_NAMES[txn.txnType] + "</td><td>" +
    ERROR_NAMES[typeKey] + "</td><td>" + crcResult + "</td><td>" +
    '<span class="pill ' + statusCls + '">' + esc(status) + "</span></td></tr>";

  $("historyBody").insertAdjacentHTML("beforeend", row);
  historyRows.push(row);
  $("historyCount").textContent = historyRows.length;
}

function renderAnalysis() {
  const order = ["NONE", "SINGLE", "MULTIPLE", "BURST"];
  let rows = "";

  order.forEach(function (key) {
    const s = stats[key];
    let note;
    let bar = "";

    if (s.runs === 0) {
      note = "Not tested yet";
    } else if (key === "NONE") {
      note = s.detected === 0 ? "No false alarms &#10003;" : "False alarm! Check the CRC code";
    } else {
      note = s.notDetected === 0
        ? "All errors detected &#10003;"
        : "CRC missed " + s.notDetected + " run(s)";
      const pct = Math.round(s.detected / s.runs * 100);
      bar = '<span class="bar" title="' + pct + '% detected"><span class="fill' +
            (s.notDetected > 0 ? " partial" : "") + '" style="width:' + pct + '%"></span></span>';
    }

    rows += "<tr><td>" + ERROR_NAMES[key] + "</td><td>" + s.runs + "</td><td>" +
            s.detected + bar + "</td><td>" + s.notDetected + "</td><td>" + note + "</td></tr>";
  });

  $("analysisBody").innerHTML = rows;
}


// ---------- Step 3: Simulate Transmission ----------

async function runTransmission(typeKey, config) {
  isSending = true;
  $("initiateBtn").disabled = true;
  $("generateBtn").disabled = true;

  // 1. The channel flips the bits
  const result = introduceError(currentTxn.codeword, typeKey, config);
  const transmitted = result.transmitted;
  const positions = result.positions;
  const flipSet = new Set(positions);
  const noisy = positions.length > 0;

  txnCounter++;
  const label = "TXN" + String(txnCounter).padStart(3, "0");

  // 2. Start the channel animation (reset first so it can restart)
  showBank(false);
  setBankIdle("Receiving", "Codeword in transit", false);
  setStage(2);
  setChannel("idle", noisy, "Channel idle");
  void $("link").offsetWidth;             // restarts the animation
  setChannel("sending", noisy, "Transmission in progress...");
  setStatus("atm", "Sending", "live");
  setStatus("bank", "Receiving", "live");
  tell(noisy
    ? "Codeword in transit, " + positions.length + (positions.length === 1 ? " bit" : " bits") + " flipping"
    : "Codeword in transit");

  // 3. Really send the codeword to the bank server (FastAPI) while the animation plays
  const request = fetch("/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction_id: label,
      transaction_type: currentTxn.txnType,
      codeword: transmitted,
      generator: GENERATOR
    })
  }).then(function (response) {
    if (!response.ok) throw new Error("server replied with status " + response.status);
    return response.json();
  });

  try {
    const reply = await Promise.all([request, sleep(2200)]);
    const data = reply[0];

    const received = data.received_codeword || transmitted;
    const receivedText = binaryToText(received.slice(0, received.length - CRC_BITS));

    // 4. The bank server shows its result automatically
    renderReceived(currentTxn, receivedText);
    renderBankSummary(currentTxn, typeKey, positions, data, transmitted.length);
    const verdict = renderFinalBanner(currentTxn, positions, data);
    renderBankDetails(received, flipSet, data);

    setChannel(
      "done",
      noisy,
      noisy
        ? positions.length + (positions.length === 1 ? " bit" : " bits") + " flipped in transit"
        : "Delivered unchanged"
    );
    showBank(true);
    setStage(3, verdict.cls);
    setStatus("atm", "Delivered", "ready");
    setStatus("bank", verdict.status, verdict.cls);
    tell(verdict.story, verdict.cls);
    refreshIcons();
    $("bankPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });

    // 5. History and analysis
    addHistory(label, currentTxn, typeKey, positions, data);
    const detected = data.crc_status === "ERROR_DETECTED";
    stats[typeKey].runs++;
    if (detected) stats[typeKey].detected++;
    else stats[typeKey].notDetected++;
    renderAnalysis();
        renderAnalysis();
    saveSession();
  } catch (err) {
    setChannel("error", false, "Transmission failed");
    setStatus("atm", "Not delivered", "bad");
    setStatus("bank", "Unreachable", "bad");
    tell("Bank server not reachable", "bad");
    setBankIdle("Bank server not reachable", "Start app.py and open http://127.0.0.1:8000", true);
  } finally {
    isSending = false;
    $("initiateBtn").disabled = false;
    $("generateBtn").disabled = false;
  }
}


// ---------- Accuracy test (many random transmissions) ----------
// Separate from the History and CRC Analysis tables: nothing here is saved.

const TEST_PER_TYPE = 1000;               // random transmissions for each error type
const TEST_TYPES = ["NONE", "SINGLE", "MULTIPLE", "BURST"];
const RING_LENGTH = 282.74;               // 2 x pi x 45, matches the ring in the CSS
let isTesting = false;

function randomAccountId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  const len = randInt(5, 8);
  for (let i = 0; i < len; i++) id += chars[randInt(0, chars.length - 1)];
  return id;
}

// A random transaction, turned into a codeword with the real CRC functions
function randomCodeword() {
  const type = Math.random() < 0.5 ? "WITHDRAW" : "DEPOSIT";
  const text = randomAccountId() + "|" + type + "|" + randInt(1, 100000);
  return generateCRC(textToBinary(text)).codeword;
}

// How the channel damages the codeword in each test group
function testConfig(typeKey) {
  if (typeKey === "SINGLE") return { singleMode: "RANDOM" };
  if (typeKey === "MULTIPLE") return { count: 2 * randInt(1, 6) };
  if (typeKey === "BURST") return { burstMode: "RANDOM", burstLength: randInt(7, 20), randomMiddle: true };
  return {};
}

function formatPct(value) {
  const r = Math.round(value * 10) / 10;
  return (r >= 100 ? "100" : r.toFixed(1)) + "%";
}

// Counts the number up while the ring fills
function tweenNumber(el, target) {
  const start = performance.now();
  const duration = 1100;
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatPct(target * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setRing(id, percent) {
  const ring = $(id);
  ring.querySelector(".fill-c").style.strokeDashoffset = RING_LENGTH * (1 - percent / 100);
  ring.setAttribute("aria-label", "Accuracy " + formatPct(percent));
  tweenNumber(ring.querySelector(".num"), percent);
}

function clearRing(id) {
  const ring = $(id);
  ring.querySelector(".fill-c").style.strokeDashoffset = RING_LENGTH;
  ring.querySelector(".num").textContent = "--";
}

function setAccNote(text, tone) {
  $("accNote").textContent = text;
  $("accNote").className = "acc-note" + (tone ? " " + tone : "");
}

async function runAccuracyTest() {
  if (isTesting || isSending) return;
  isTesting = true;
  $("runTestBtn").disabled = true;
  $("runTestLabel").textContent = "Running...";
  setAccNote("Running test...", "");
  clearRing("ringAll");
  TEST_TYPES.forEach(function (key) {
    clearRing("ring" + key);
    $("cnt" + key).innerHTML = "&nbsp;";
  });
  $("cntAll").innerHTML = "&nbsp;";

  try {
    await sleep(40);                      // lets the screen update first

    // 1. Build the test transmissions with the real CRC and error functions
    const items = [];
    const groupOf = [];
    TEST_TYPES.forEach(function (key) {
      for (let k = 0; k < TEST_PER_TYPE; k++) {
        const sent = introduceError(randomCodeword(), key, testConfig(key)).transmitted;
        items.push({ id: items.length, codeword: sent });
        groupOf.push(key);
      }
    });

    // 2. One batch request to the bank server
    const response = await fetch("/verify_batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generator: GENERATOR, items: items })
    });
    if (response.status === 404) throw new Error("add /verify_batch to app.py");
    if (!response.ok) throw new Error("server replied with status " + response.status);
    const data = await response.json();
    if (!Array.isArray(data.results) || data.results.length !== items.length) {
      throw new Error("incomplete reply from the bank");
    }

    // 3. Count: no-error runs are correct when accepted, the others when detected
    const correct = { NONE: 0, SINGLE: 0, MULTIPLE: 0, BURST: 0 };
    data.results.forEach(function (r) {
      const key = groupOf[r.id];
      const ok = key === "NONE" ? !r.detected : r.detected;
      if (ok) correct[key]++;
    });

    let total = 0;
    TEST_TYPES.forEach(function (key) {
      total += correct[key];
      setRing("ring" + key, correct[key] / TEST_PER_TYPE * 100);
      $("cnt" + key).textContent = correct[key] + " / " + TEST_PER_TYPE;
    });
    setRing("ringAll", total / items.length * 100);
    $("cntAll").textContent = total + " / " + items.length;
       setAccNote("Measured over " + items.length.toLocaleString("en-US") +
      " test transmissions. Hardest cases: even-bit and long burst errors", "");
  } catch (err) {
    setAccNote("Test failed: " + err.message, "bad");
  } finally {
    isTesting = false;
    $("runTestBtn").disabled = false;
    $("runTestLabel").textContent = "Run accuracy test";
  }
}

$("runTestBtn").addEventListener("click", runAccuracyTest);


// ---------- Connecting the buttons ----------

$("generateBtn").addEventListener("click", generateTransaction);

// Clear the form message as soon as the user edits a field
$("accId").addEventListener("input", function () { showFormError(""); });
$("amount").addEventListener("input", function () { showFormError(""); });

// Initiate Transmission opens the configuration pop-up
$("initiateBtn").addEventListener("click", function () {
  if (isSending || !currentTxn) return;
  openModal();
});

$("simulateBtn").addEventListener("click", function () {
  const typeKey = getRadio("errorType");
  const checked = validateConfig(typeKey);

  if (checked.error) {
    $("modalError").textContent = checked.error;     // stay open, show the problem
    return;
  }

  closeModal();
  runTransmission(typeKey, checked.config);
});

// Close the pop-up: X button, click outside it, or the Esc key
$("closeModalBtn").addEventListener("click", closeModal);

$("modalBackdrop").addEventListener("click", function (event) {
  if (event.target === event.currentTarget) closeModal();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !$("modalBackdrop").hidden) closeModal();
});

// Show the right extra options when a choice changes
document.querySelectorAll('#modal input[type="radio"]').forEach(function (radio) {
  radio.addEventListener("change", updateModalOptions);
});

loadSession();
renderAnalysis();
setStage(1);
refreshIcons();