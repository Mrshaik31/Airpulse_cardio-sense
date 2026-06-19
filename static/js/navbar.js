document.addEventListener("DOMContentLoaded", function () {
  const btn = document.getElementById("modelInfoBtn");
  const modal = document.getElementById("modelInfoModal");
  const closeA = document.getElementById("modelInfoClose");
  const closeB = document.getElementById("modelInfoClose2");
  const content = document.getElementById("modelInfoContent");
  const mobileBtn = document.getElementById("mobileMenuBtn");
  const mobileMenu = document.getElementById("mobileMenu");
  const hamburgerIcon = document.getElementById("hamburgerIcon");
  const closeIcon = document.getElementById("closeIcon");
  const modelInfoBtnMobile = document.getElementById("modelInfoBtnMobile");
  const teamBtn = document.getElementById("teamBtn");
  const teamBtnMobile = document.getElementById("teamBtnMobile");
  const teamModal = document.getElementById("teamModal");
  const teamModalClose = document.getElementById("teamModalClose");
  const teamModalClose2 = document.getElementById("teamModalClose2");
  const teamModalContent = document.getElementById("teamModalContent");

  // Do not bail out early; gracefully handle missing elements.

  // Toggle mobile menu if present
  if (mobileBtn && mobileMenu) {
    mobileBtn.addEventListener("click", function (e) {
      const expanded = mobileBtn.getAttribute("aria-expanded") === "true";
      mobileBtn.setAttribute("aria-expanded", String(!expanded));
      mobileMenu.classList.toggle("hidden");
      if (hamburgerIcon && closeIcon) {
        hamburgerIcon.classList.toggle("hidden");
        closeIcon.classList.toggle("hidden");
      }
    });

    // Close mobile menu when a link is clicked (improves UX)
    mobileMenu.querySelectorAll("a, button").forEach((el) => {
      el.addEventListener("click", () => {
        mobileMenu.classList.add("hidden");
        mobileBtn.setAttribute("aria-expanded", "false");
        if (hamburgerIcon && closeIcon) {
          hamburgerIcon.classList.remove("hidden");
          closeIcon.classList.add("hidden");
        }
      });
    });
  }

  function openModal() {
    modal.classList.remove("hidden");
    // set loading state
    content.innerHTML =
      '<p class="italic text-slate-500">Loading model information…</p>';
    // fetch model info
    fetch("/model-info")
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.model) {
          const m = j.model;
          const html = [];
          html.push(
            `<p><strong>Model path:</strong> <code>${
              m.model_path || "N/A"
            }</code></p>`
          );
          html.push(
            `<p><strong>Exists on server:</strong> ${
              m.model_exists ? "Yes" : "No"
            }</p>`
          );
          html.push(`<p><strong>Device:</strong> ${m.device}</p>`);
          html.push(`<p><strong>Sample rate:</strong> ${m.sample_rate} Hz</p>`);
          html.push(`<p><strong>Chunk (sec):</strong> ${m.chunk_seconds}</p>`);
          html.push(`<p><strong>Num classes:</strong> ${m.num_classes}</p>`);
          if (Array.isArray(m.classes)) {
            html.push("<p><strong>Classes:</strong></p>");
            html.push(
              '<ul class="list-disc pl-5 mt-1 text-sm">' +
                m.classes.map((c) => `<li>${c}</li>`).join("") +
                "</ul>"
            );
          }
          content.innerHTML = html.join("\n");
        } else {
          content.innerHTML = `<p class="text-red-600">Failed to read model info</p><pre class="mt-2 text-xs">${JSON.stringify(
            j,
            null,
            2
          )}</pre>`;
        }
      })
      .catch((err) => {
        content.innerHTML = `<p class="text-red-600">Error fetching model info</p><pre class="mt-2 text-xs">${String(
          err
        )}</pre>`;
      });
    // focus for accessibility
    setTimeout(() => {
      const first = modal.querySelector('[role="dialog"]');
      if (first) first.focus();
    }, 60);
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  if (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      openModal();
    });
  }

  // Mobile model info button should open same modal
  if (modelInfoBtnMobile) {
    modelInfoBtnMobile.addEventListener("click", function (e) {
      e.preventDefault();
      openModal();
    });
  }

  // Team modal handlers
  function openTeamModal() {
    if (!teamModal) return;
    teamModal.classList.remove("hidden");
    // ensure content is present (already in template) - focus for accessibility
    setTimeout(() => {
      const first = teamModal.querySelector('[role="dialog"]');
      if (first) first.focus();
    }, 60);
  }

  function closeTeamModal() {
    if (!teamModal) return;
    teamModal.classList.add("hidden");
  }

  if (teamBtn) {
    teamBtn.addEventListener("click", function (e) {
      e.preventDefault();
      openTeamModal();
    });
  }

  if (teamBtnMobile) {
    teamBtnMobile.addEventListener("click", function (e) {
      e.preventDefault();
      openTeamModal();
    });
  }

  [teamModalClose, teamModalClose2].forEach((el) => {
    if (el) el.addEventListener("click", closeTeamModal);
  });

  if (teamModal) {
    teamModal.addEventListener("click", function (e) {
      if (
        e.target &&
        e.target.getAttribute &&
        e.target.getAttribute("data-close") === "true"
      ) {
        closeTeamModal();
      }
    });
  }

  // close team modal on Escape as well
  document.addEventListener("keydown", function (e) {
    if (
      e.key === "Escape" &&
      teamModal &&
      !teamModal.classList.contains("hidden")
    ) {
      closeTeamModal();
    }
  });

  [closeA, closeB].forEach((el) => {
    if (el) el.addEventListener("click", closeModal);
  });

  // allow clicking backdrop to close
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (
        e.target &&
        e.target.getAttribute &&
        e.target.getAttribute("data-close") === "true"
      ) {
        closeModal();
      }
    });
  }

  // close on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });
});
