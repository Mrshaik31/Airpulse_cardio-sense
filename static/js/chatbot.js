document.addEventListener("DOMContentLoaded", function () {
  const recSelect = document.getElementById("recSelect");
  const recSummary = document.getElementById("recSummary");
  const startChatBtn = document.getElementById("startChatBtn");
  const chatSection = document.getElementById("chatSection");
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const chatSend = document.getElementById("chatSend");

  let recordings = [];
  let selectedRec = null;
  let systemPrompt = null;
  let chatHistory = [];

  // Fetch recordings and populate selector
  async function loadRecordings() {
    recSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const resp = await fetch("/api/recordings_for_chat");
      const data = await resp.json();
      recordings = data.recordings || [];
      recSelect.innerHTML = '<option value="">Select a recording...</option>';
      recordings.forEach((rec) => {
        const opt = document.createElement("option");
        opt.value = rec.id;
        opt.textContent = `${rec.title || rec.filename} (${rec.created_at})`;
        recSelect.appendChild(opt);
      });
    } catch (e) {
      recSelect.innerHTML =
        '<option value="">Error loading recordings</option>';
    }
  }

  recSelect.addEventListener("change", function () {
    const recId = recSelect.value;
    selectedRec = recordings.find((r) => r.id == recId);
    if (selectedRec && selectedRec.summary) {
      const s = selectedRec.summary;
      recSummary.innerHTML = `<b>Decision:</b> ${s.decision}<br><b>Predicted:</b> ${s.predicted_class}<br><b>Confidence:</b> ${s.confidence}%`;
      startChatBtn.disabled = false;
    } else {
      recSummary.textContent = "No analysis summary available.";
      startChatBtn.disabled = true;
    }
  });

  startChatBtn.addEventListener("click", function () {
    if (!selectedRec || !selectedRec.summary) return;
    systemPrompt = `Analysis summary for recording '${
      selectedRec.title || selectedRec.filename
    }':\nDecision: ${selectedRec.summary.decision}\nPredicted: ${
      selectedRec.summary.predicted_class
    }\nConfidence: ${selectedRec.summary.confidence}%`;
    chatSection.classList.remove("hidden");
    chatMessages.innerHTML = "";
    chatHistory = [];
    appendMessage("system", systemPrompt);
    appendMessage(
      "assistant",
      "What would you like to know about these results?"
    );
  });

  function appendMessage(role, text) {
    const elWrap = document.createElement("div");
    elWrap.className = role === "user" ? "self-end" : "self-start";
    const bubble = document.createElement("div");
    bubble.className =
      "chat-bubble " +
      (role === "assistant"
        ? "assistant"
        : role === "user"
        ? "user"
        : "assistant");
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = `${role} • ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
    const txt = document.createElement("div");
    txt.className = "chat-text";
    txt.innerHTML = escapeHtml(text || "");
    bubble.appendChild(meta);
    bubble.appendChild(txt);
    elWrap.appendChild(bubble);
    chatMessages.appendChild(elWrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(s) {
    return (s + "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  chatSend.addEventListener("click", async function () {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    appendMessage("user", text);
    chatHistory.push({ role: "user", content: text });
    appendTyping();
    // Build messages: system prompt + history
    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory,
    ];
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const json = await resp.json();
      removeTyping();
      if (json.ok) {
        appendMessage("assistant", json.reply);
        chatHistory.push({ role: "assistant", content: json.reply });
      } else {
        appendMessage(
          "assistant",
          `Error: ${json.error || json.detail || "Unknown"}`
        );
      }
    } catch (e) {
      removeTyping();
      appendMessage("assistant", "Network error: " + e);
    }
  });

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatSend.click();
    }
  });

  function appendTyping() {
    const elWrap = document.createElement("div");
    elWrap.className = "self-start";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.innerHTML = `<div class="chat-typing"><span></span><span style="animation-delay:0.2s"></span><span style="animation-delay:0.4s"></span></div>`;
    elWrap.appendChild(bubble);
    chatMessages.appendChild(elWrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    window._chatTypingEl = elWrap;
  }
  function removeTyping() {
    if (window._chatTypingEl && window._chatTypingEl.parentNode) {
      window._chatTypingEl.parentNode.removeChild(window._chatTypingEl);
    }
    window._chatTypingEl = null;
  }

  loadRecordings();
});
