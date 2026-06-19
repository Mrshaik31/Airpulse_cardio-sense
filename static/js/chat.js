/* Chat modal UI and backend proxy client
   Exposes window.openChatWithAI(initialText, opts)
   The backend expects an env var OPENAI_API_KEY to be set; if not present the API will return an informative error.
*/

document.addEventListener("DOMContentLoaded", function () {
  const modal = document.getElementById("chatModal");
  const closeBtn = document.getElementById("chatClose");
  const closeBtn2 = document.getElementById("chatClose2");
  const container = document.getElementById("chatContainer");
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSend");

  // OPTIONAL: local fallback key for this browser ONLY.
  // Replace "YOUR_OPENAI_API_KEY_HERE" with your real key **locally** (never commit it or share it).
  // Local fallback key intentionally left blank to avoid shipping secrets in repo.
  // You can paste a test key into the UI or set sessionStorage OPENAI_KEY_TMP for local testing.
  const LOCAL_OPENAI_KEY_FALLBACK = "";

  if (!modal) return;

  function openModal() {
    clearNotice();
    modal.classList.remove("hidden");
    input.focus();
  }
  function closeModal() {
    clearNotice();
    modal.classList.add("hidden");
  }

  [closeBtn, closeBtn2].forEach((el) => {
    if (el) el.addEventListener("click", closeModal);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  const noticeEl = document.getElementById("chatNotice");
  function showNotice(msg) {
    if (!noticeEl) return;
    noticeEl.textContent = msg || "";
    noticeEl.classList.remove("hidden");
  }
  function clearNotice() {
    if (!noticeEl) return;
    noticeEl.textContent = "";
    noticeEl.classList.add("hidden");
  }

  function appendMessage(role, text) {
    const elWrap = document.createElement("div");
    elWrap.className = role === "user" ? "self-end" : "self-start";

    // Build bubble
    const bubble = document.createElement("div");
    bubble.className =
      "chat-bubble " +
      (role === "assistant"
        ? "assistant"
        : role === "user"
        ? "user"
        : "assistant");

    // Meta (role + time)
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    try {
      meta.textContent = `${role} • ${new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    } catch (e) {
      meta.textContent = role;
    }

    const txt = document.createElement("div");
    txt.className = "chat-text";
    txt.innerHTML = escapeHtml(text || "");

    if (role === "system") {
      bubble.className = "chat-bubble assistant";
      bubble.innerHTML = `<div class="text-xs text-slate-500 mb-1">system</div><div class="text-xs text-slate-700">${escapeHtml(
        text
      )}</div>`;
      elWrap.appendChild(bubble);
    } else {
      bubble.appendChild(meta);
      bubble.appendChild(txt);
      elWrap.appendChild(bubble);
    }

    container.appendChild(elWrap);
    container.scrollTop = container.scrollHeight;
  }

  let _typingEl = null;
  function appendTyping() {
    if (_typingEl) return _typingEl;
    const elWrap = document.createElement("div");
    elWrap.className = "self-start";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.innerHTML = `<div class="chat-typing"><span></span><span style="animation-delay:0.2s"></span><span style="animation-delay:0.4s"></span></div>`;
    elWrap.appendChild(bubble);
    container.appendChild(elWrap);
    container.scrollTop = container.scrollHeight;
    _typingEl = elWrap;
    return _typingEl;
  }

  function removeTyping() {
    if (_typingEl && _typingEl.parentNode) {
      _typingEl.parentNode.removeChild(_typingEl);
    }
    _typingEl = null;
  }

  function escapeHtml(s) {
    return (s + "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  async function sendMessage(messages) {
    appendMessage("user", messages[messages.length - 1].content);
    try {
      appendTyping();
      // include system prompt if present
      const outMessages = [];
      if (window.__chat_system_prompt)
        outMessages.push({
          role: "system",
          content: window.__chat_system_prompt,
        });
      outMessages.push(...messages);

      // prefer server proxy first
      let json = null;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: outMessages }),
        });
        json = await res.json();
      } catch (e) {
        json = { ok: false, error: "proxy_unreachable", detail: String(e) };
      }

      // remove typing indicator if present
      removeTyping();
      // clear any previous notices on each attempt
      clearNotice();

      // if proxy failed or reported missing key, attempt client-side key fallback
      const hasLocalKeyInSession = !!sessionStorage.getItem("OPENAI_KEY_TMP");
      const missingKey =
        json &&
        !json.ok &&
        ((json.error &&
          json.error.toString().toLowerCase().includes("openai api key")) ||
          (json.detail &&
            json.detail.toString().toLowerCase().includes("openai api key")) ||
          json.error === "proxy_unreachable");

      // If proxy missing key AND we have a sessionStorage key or local fallback → use client-side
      if (missingKey && (hasLocalKeyInSession || LOCAL_OPENAI_KEY_FALLBACK)) {
        // Prefer a non-chat-notification notice for proxy fallback so we don't spam assistant bubbles.
        showNotice(
          hasLocalKeyInSession
            ? "Server proxy unavailable — using local API key stored in this session."
            : "Server proxy unavailable — using client fallback key configured in this browser."
        );
        const clientResp = await clientSideChat(outMessages);
        clearNotice();
        if (clientResp && clientResp.ok) {
          appendMessage("assistant", clientResp.reply || "(no reply)");
          return;
        } else {
          appendMessage(
            "assistant",
            `Local key error: ${
              (clientResp && (clientResp.error || clientResp.detail)) ||
              "Unknown"
            }`
          );
          return;
        }
      }

      if (missingKey && !hasLocalKeyInSession && !LOCAL_OPENAI_KEY_FALLBACK) {
        showNotice(
          "Server proxy unavailable or API key not configured. Paste an OpenAI key below to use chat from this browser session."
        );
        showKeyPrompt();
        return;
      }

      if (!json.ok) {
        // show error as assistant message for visibility
        appendMessage(
          "assistant",
          `Error from proxy: ${json.error || json.detail || "Unknown"}`
        );
        return;
      }

      clearNotice();
      appendMessage("assistant", json.reply || JSON.stringify(json, null, 2));
    } catch (err) {
      appendMessage("assistant", "Network error: " + String(err));
    }
  }

  // Helper: show API key input prompt inside modal to allow direct client calls
  function showKeyPrompt() {
    // if already shown, skip
    if (document.getElementById("chatKeyRow")) return;
    const row = document.createElement("div");
    row.id = "chatKeyRow";
    row.className =
      "mt-3 p-3 bg-yellow-50 border border-yellow-100 rounded text-sm";
    row.innerHTML = `
      <div class="mb-2 text-xs text-slate-700">Server proxy not available or OpenAI key not configured. Paste an OpenAI API key here to use chat from this browser for the current session. The key will be stored in sessionStorage only.</div>
      <div class="flex gap-2">
        <input id="chatTempKey" class="flex-1 border rounded p-2 text-sm" type="password" placeholder="sk-..." />
        <button id="chatUseKey" class="btn">Use Key</button>
      </div>
    `;
    // place before the input row
    const dialogP = modal.querySelector('[role="dialog"] .p-4');
    if (dialogP) dialogP.appendChild(row);

    document
      .getElementById("chatUseKey")
      .addEventListener("click", async function () {
        const k = document.getElementById("chatTempKey").value.trim();
        if (!k) return alert("Please paste the API key");
        try {
          sessionStorage.setItem("OPENAI_KEY_TMP", k);
        } catch (e) {
          console.warn("sessionStorage failed", e);
        }
        appendMessage(
          "assistant",
          "Stored key in session. Please re-send your question."
        );
      });
  }

  // client-side direct call using a key from sessionStorage or local fallback
  async function clientSideChat(messages) {
    // Prefer session storage; if not present, use local fallback constant
    const key =
      sessionStorage.getItem("OPENAI_KEY_TMP") || LOCAL_OPENAI_KEY_FALLBACK;

    if (!key || !key.trim()) {
      return { ok: false, error: "no_local_key" };
    }

    try {
      const body = {
        model: "gpt-3.5-turbo",
        messages,
        max_tokens: 512,
        temperature: 0.7,
      };
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key.trim(),
        },
        body: JSON.stringify(body),
      });
      const j = await resp.json();
      if (!resp.ok) return { ok: false, error: "openai_error", detail: j };
      const reply =
        j.choices &&
        j.choices[0] &&
        j.choices[0].message &&
        j.choices[0].message.content;
      return { ok: true, reply };
    } catch (err) {
      return { ok: false, error: "network", detail: String(err) };
    }
  }

  sendBtn.addEventListener("click", async function () {
    const text = input.value && input.value.trim();
    if (!text) return;
    const messages = [{ role: "user", content: text }];
    input.value = "";
    await sendMessage(messages);
  });

  // allow Enter to send (Shift+Enter for newline)
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // public helper to open chat with initial context (analysis text)
  window.openChatWithAI = function (initialText) {
    container.innerHTML = "";
    // save the analysis as a system prompt so subsequent user messages include it
    window.__chat_system_prompt = initialText || null;
    if (initialText) {
      appendMessage("system", "Analysis summary:");
      appendMessage("assistant", initialText);
    }
    openModal();
  };
});
