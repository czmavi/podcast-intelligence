const requestConfirmation = (message, submitLabel = "Pokračovat") => {
  const dialog = document.querySelector("#confirmation-dialog");
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function") {
    return Promise.resolve(globalThis.confirm(message));
  }
  const text = dialog.querySelector("[data-confirmation-message]");
  const submit = dialog.querySelector("[data-confirmation-submit]");
  if (text) text.textContent = message;
  if (submit) submit.textContent = submitLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    });
  });
};

for (const logo of document.querySelectorAll(".podcast-logo")) {
  logo.addEventListener("error", () => logo.setAttribute("hidden", ""), { once: true });
}

const filterDropdowns = new WeakMap();
let filterDropdownId = 0;

const foldFilterText = (value) =>
  String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs").trim();

const initFilterDropdown = (select) => {
  if (filterDropdowns.has(select)) return filterDropdowns.get(select);

  filterDropdownId += 1;
  const controlId = `filter-dropdown-${filterDropdownId}`;
  const listId = `${controlId}-list`;
  const wasRequired = select.required;
  const wrapper = document.createElement("div");
  const control = document.createElement("div");
  const input = document.createElement("input");
  const toggle = document.createElement("button");
  const list = document.createElement("div");
  let visibleOptions = [];
  let activeIndex = -1;

  wrapper.className = "filter-dropdown";
  control.className = "filter-dropdown-control";
  input.id = controlId;
  input.type = "text";
  input.className = "filter-dropdown-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = select.dataset.filterPlaceholder || "Začněte psát…";
  input.required = wasRequired;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", select.dataset.filterLabel || "Filtrovat možnosti");
  toggle.type = "button";
  toggle.className = "filter-dropdown-toggle";
  toggle.tabIndex = -1;
  toggle.textContent = "⌄";
  toggle.setAttribute("aria-label", "Otevřít nabídku");
  list.id = listId;
  list.className = "filter-dropdown-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  select.before(wrapper);
  control.append(input, toggle);
  wrapper.append(control, list, select);
  select.classList.add("filter-dropdown-native");
  select.tabIndex = -1;
  select.required = false;
  select.setAttribute("aria-hidden", "true");

  const selectedOption = () => select.options[select.selectedIndex] || null;

  const syncValidity = () => {
    const missingSelection = wasRequired && !select.disabled && !select.value;
    input.setCustomValidity(missingSelection ? "Vyberte osobu ze seznamu." : "");
  };

  const setActive = (index) => {
    if (visibleOptions.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = Math.max(0, Math.min(index, visibleOptions.length - 1));
    for (const [optionIndex, option] of visibleOptions.entries()) {
      option.element.classList.toggle("active", optionIndex === activeIndex);
    }
    const active = visibleOptions[activeIndex]?.element;
    if (!active) return;
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  };

  const choose = (value) => {
    select.value = value;
    const option = selectedOption();
    input.value = option?.textContent?.trim() || "";
    syncValidity();
    select.dispatchEvent(new Event("change", { bubbles: true }));
    list.hidden = true;
    wrapper.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const renderOptions = (query = "") => {
    const foldedQuery = foldFilterText(query);
    const options = [...select.options].filter((option) =>
      !option.disabled && (!foldedQuery || foldFilterText(option.textContent).includes(foldedQuery))
    );
    list.replaceChildren();
    visibleOptions = options.map((option, index) => {
      const item = document.createElement("button");
      item.id = `${listId}-option-${index}`;
      item.type = "button";
      item.className = "filter-dropdown-option";
      item.tabIndex = -1;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === select.value));
      item.textContent = option.textContent?.trim() || "";
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        choose(option.value);
        input.focus();
      });
      list.append(item);
      return { element: item, value: option.value };
    });
    if (visibleOptions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "filter-dropdown-empty";
      empty.textContent = "Žádná shoda";
      list.append(empty);
      setActive(-1);
      return;
    }
    const selectedIndex = visibleOptions.findIndex((option) => option.value === select.value);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
  };

  const open = (query = "") => {
    if (select.disabled) return;
    renderOptions(query);
    list.hidden = false;
    wrapper.classList.add("open");
    input.setAttribute("aria-expanded", "true");
  };

  const close = (restoreSelection = true) => {
    list.hidden = true;
    wrapper.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (restoreSelection) input.value = selectedOption()?.textContent?.trim() || "";
  };

  const sync = () => {
    const option = selectedOption();
    input.value = option?.textContent?.trim() || "";
    input.disabled = select.disabled;
    input.required = wasRequired && !select.disabled;
    toggle.disabled = select.disabled;
    wrapper.classList.toggle("disabled", select.disabled);
    syncValidity();
    if (!list.hidden) renderOptions();
  };

  input.addEventListener("focus", () => {
    input.select();
    open();
  });
  input.addEventListener("input", () => {
    const optionLabel = selectedOption()?.textContent?.trim() || "";
    if (input.value !== optionLabel) select.value = "";
    syncValidity();
    open(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) {
        open(input.value === selectedOption()?.textContent?.trim() ? "" : input.value);
      }
      setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" && !list.hidden && activeIndex >= 0) {
      event.preventDefault();
      choose(visibleOptions[activeIndex].value);
      return;
    }
    if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      close();
      input.select();
      return;
    }
    if (event.key === "Tab") close();
  });
  toggle.addEventListener("click", () => {
    const shouldOpen = !wrapper.classList.contains("open");
    input.focus();
    if (shouldOpen) {
      input.select();
      open();
    } else {
      close();
    }
  });
  select.addEventListener("change", sync);
  document.addEventListener("pointerdown", (event) => {
    if (!wrapper.contains(event.target)) close();
  });
  new MutationObserver(sync).observe(select, {
    attributes: true,
    attributeFilter: ["disabled"],
    childList: true,
    subtree: true,
  });

  const dropdown = { sync };
  filterDropdowns.set(select, dropdown);
  sync();
  return dropdown;
};

for (const select of document.querySelectorAll("select[data-filter-dropdown]")) {
  initFilterDropdown(select);
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-seek]");
  if (target) {
    const audio = document.querySelector("audio");
    if (audio) {
      audio.currentTime = Number(target.dataset.seek);
      await audio.play();
    }
  }
  const action = event.target.closest("[data-action]");
  if (!action) return;
  event.preventDefault();
  if (
    action.dataset.confirm &&
    !await requestConfirmation(
      action.dataset.confirm,
      action.dataset.confirmLabel || "Ano, opakovat",
    )
  ) return;
  const originalLabel = action.textContent;
  action.disabled = true;
  action.textContent = action.dataset.loadingLabel || "Pracuji…";
  try {
    const response = await fetch(action.dataset.action, {
      method: action.dataset.method || "POST",
      headers: { "content-type": "application/json" },
      body: action.dataset.body || "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Požadavek selhal.");
    if (action.dataset.success === "alert") {
      alert(result.message || "Akce byla dokončena.");
      action.disabled = false;
      action.textContent = originalLabel;
      return;
    }
    location.reload();
  } catch (error) {
    alert(error.message);
    action.disabled = false;
    action.textContent = originalLabel;
  }
});

const searchFilterRequests = new WeakMap();

const replaceSelectOptions = (select, emptyLabel, options, selectedValue = "") => {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.append(empty);
  for (const item of options) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = String(item.label);
    option.selected = option.value === selectedValue;
    select.append(option);
  }
};

async function loadSearchFilters(form, resetEpisode) {
  const podcast = form.querySelector("[data-search-podcast]");
  const episode = form.querySelector("[data-search-episode]");
  const person = form.querySelector("[data-search-person]");
  if (!podcast || !episode || !person) return;
  searchFilterRequests.get(form)?.abort();
  const controller = new AbortController();
  searchFilterRequests.set(form, controller);
  const podcastId = podcast.value;
  const selectedEpisodeId = resetEpisode ? "" : episode.value;
  if (!podcastId) {
    replaceSelectOptions(episode, "nejdřív vyberte podcast", []);
    replaceSelectOptions(person, "nejdřív vyberte podcast", []);
    episode.disabled = true;
    person.disabled = true;
    return;
  }
  episode.disabled = true;
  person.disabled = true;
  try {
    const parameters = new URLSearchParams({ podcastId });
    if (selectedEpisodeId) parameters.set("episodeId", selectedEpisodeId);
    const response = await fetch(`/api/search/filters?${parameters}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Filtry se nepodařilo načíst.");
    replaceSelectOptions(
      episode,
      "všechny epizody",
      result.episodes || [],
      selectedEpisodeId,
    );
    replaceSelectOptions(person, "všichni mluvčí", result.people || []);
    episode.disabled = (result.episodes || []).length === 0;
    person.disabled = (result.people || []).length === 0;
  } catch (error) {
    if (error.name === "AbortError") return;
    replaceSelectOptions(episode, "epizody se nepodařilo načíst", []);
    replaceSelectOptions(person, "mluvčí se nepodařilo načíst", []);
    console.error(error);
  } finally {
    if (searchFilterRequests.get(form) === controller) searchFilterRequests.delete(form);
  }
}

for (const form of document.querySelectorAll("form[data-search-filters]")) {
  const podcast = form.querySelector("[data-search-podcast]");
  const episode = form.querySelector("[data-search-episode]");
  podcast?.addEventListener("change", () => loadSearchFilters(form, true));
  episode?.addEventListener("change", () => loadSearchFilters(form, false));
  if (podcast?.value) loadSearchFilters(form, false);
}

const updateSpeakerAssignmentForm = (form) => {
  const assignmentType = form.querySelector('input[name="assignmentType"]:checked')?.value;
  for (const panel of form.querySelectorAll("[data-assignment-panel]")) {
    const active = panel.dataset.assignmentPanel === assignmentType;
    panel.hidden = !active;
    for (const control of panel.querySelectorAll("input, select, textarea")) {
      control.disabled = !active;
    }
  }
};

for (const form of document.querySelectorAll("form[data-speaker-assignment]")) {
  form.addEventListener("change", (event) => {
    if (event.target.matches('input[name="assignmentType"]')) {
      updateSpeakerAssignmentForm(form);
    }
  });
  updateSpeakerAssignmentForm(form);
}

for (const button of document.querySelectorAll("[data-speaker-edit]")) {
  button.addEventListener("click", () => {
    const card = button.closest("[data-speaker-card]");
    const editor = card?.querySelector("[data-speaker-editor]");
    const form = editor?.querySelector("form[data-speaker-assignment]");
    if (!card || !editor || !form) return;
    editor.hidden = false;
    button.hidden = true;
    card.classList.remove("speaker-compact");
    updateSpeakerAssignmentForm(form);
    form.querySelector(
      "[data-assignment-panel]:not([hidden]) select, " +
        "[data-assignment-panel]:not([hidden]) input, " +
        "[data-assignment-panel]:not([hidden]) textarea",
    )?.focus();
  });
}

const formatPublishedDate = (value) => {
  if (!value) return "datum neuvedeno";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "datum neuvedeno";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(date);
};

const answerSourceReferenceHtml = (source) =>
  `<a class="answer-section-reference"
    href="/episodes/${encodeURIComponent(source.episodeId)}?at=${Number(source.startSeconds)}">
    <strong>${escapeHtml(source.episodeTitle)}</strong>
    <span>${escapeHtml(formatPublishedDate(source.publishedAt))} · ${
    formatTime(source.startSeconds)
  }</span></a>`;

const answerSectionsHtml = (sections, sources) => {
  const sourceById = new Map((sources || []).map((source) => [source.sourceId, source]));
  return (sections || []).map((section) => {
    const references = (section.sourceIds || []).map((sourceId) => sourceById.get(sourceId)).filter(
      Boolean,
    );
    return `<section class="answer-section"><h3>${escapeHtml(section.title)}</h3>
      <p>${escapeHtml(section.text)}</p>
      <div class="answer-section-references">${
      references.map(answerSourceReferenceHtml).join("")
    }</div></section>`;
  }).join("");
};

const answerWarningsHtml = (warnings) =>
  (warnings || []).map((warning) => `<p class="danger">${escapeHtml(warning)}</p>`).join("");

const tokenCount = new Intl.NumberFormat("cs-CZ");
const answerUsageHtml = (usage) => {
  if (!usage) return "";
  return `<dl class="answer-usage" aria-label="Použité tokeny modelu">
    <div><dt>Vstup</dt><dd>${tokenCount.format(Number(usage.promptTokens) || 0)}</dd></div>
    <div><dt>Výstup</dt><dd>${tokenCount.format(Number(usage.completionTokens) || 0)}</dd></div>
    <div><dt>Celkem tokenů</dt><dd>${tokenCount.format(Number(usage.totalTokens) || 0)}</dd></div>
  </dl>`;
};

async function renderAskStream(response, target) {
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Požadavek selhal.");
  }
  if (!response.body) throw new Error("Server nevrátil stream odpovědi.");
  target.innerHTML = `<div class="answer-progress card">
    <ol class="answer-phases" aria-live="polite"></ol>
    <div class="answer-stream hidden"><p data-answer-text></p>
      <div class="answer-sections" data-answer-sections></div></div>
    <div data-answer-result></div></div>`;
  const phases = target.querySelector(".answer-phases");
  const answerBox = target.querySelector(".answer-stream");
  const answerText = target.querySelector("[data-answer-text]");
  const answerSections = target.querySelector("[data-answer-sections]");
  const resultBox = target.querySelector("[data-answer-result]");
  let visibleAnswer = "";
  let activePhase = null;
  let activeSince = 0;
  const phaseTimer = setInterval(() => {
    const time = activePhase?.querySelector("[data-phase-time]");
    if (time) time.textContent = `${Math.max(0, Math.floor((Date.now() - activeSince) / 1000))} s`;
  }, 1000);
  const finishPhase = (state = "done") => {
    if (!activePhase) return;
    activePhase.classList.remove("active");
    activePhase.classList.add(state);
    const time = activePhase.querySelector("[data-phase-time]");
    if (time) {
      time.textContent = `${Math.max(0, Math.round((Date.now() - activeSince) / 100) / 10)} s`;
    }
    activePhase = null;
  };
  const handle = (event) => {
    if (event.type === "phase") {
      finishPhase();
      activeSince = Date.now();
      phases.insertAdjacentHTML(
        "beforeend",
        `<li class="answer-phase active" data-phase="${escapeHtml(event.phase)}">
          <span class="phase-dot" aria-hidden="true"></span>
          <span>${escapeHtml(event.message)}</span><small data-phase-time>0 s</small></li>`,
      );
      activePhase = phases.lastElementChild;
      return;
    }
    if (event.type === "delta") {
      visibleAnswer += String(event.text || "");
      answerBox.classList.remove("hidden");
      answerBox.classList.add("streaming");
      answerText.textContent = visibleAnswer;
      return;
    }
    if (event.type === "complete") {
      finishPhase();
      answerBox.classList.remove("streaming");
      if (event.answer) {
        const confidenceLabel = { low: "nízká", medium: "střední", high: "vysoká" }[
          event.confidence
        ] || event.confidence;
        answerBox.classList.remove("hidden");
        answerText.textContent = event.answer;
        answerSections.innerHTML = answerSectionsHtml(event.sections, event.sources);
        resultBox.innerHTML =
          `<span class="status relevance-${escapeHtml(event.confidence)}">Jistota: ${
            escapeHtml(confidenceLabel)
          }</span>` + answerUsageHtml(event.usage) + answerWarningsHtml(event.warnings);
      } else {
        resultBox.innerHTML = answerWarningsHtml(event.warnings);
      }
      return;
    }
    if (event.type === "error") {
      finishPhase("failed");
      answerBox.classList.remove("streaming");
      resultBox.innerHTML = `<p class="danger">${escapeHtml(event.message)}</p>`;
    }
  };

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += (value || "") + (done ? "\n" : "");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) handle(JSON.parse(line));
      }
      if (done) break;
    }
  } finally {
    clearInterval(phaseTimer);
    reader.releaseLock();
  }
}

for (const form of document.querySelectorAll("form[data-toggle-form]")) {
  const input = form.querySelector("[data-toggle-input]");
  input?.addEventListener("change", () => {
    input.dataset.previousChecked = String(!input.checked);
    form.requestSubmit();
  });
}

for (const form of document.querySelectorAll("form[data-api]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const toggleInput = form.querySelector("[data-toggle-input]");
    const originalLabel = submit?.textContent;
    try {
      const body = Object.fromEntries(new FormData(form));
      for (const [key, value] of Object.entries(body)) {
        if (value === "") delete body[key];
      }
      for (const checkbox of form.querySelectorAll("input[type=checkbox]")) {
        body[checkbox.name] = checkbox.checked;
      }
      if (submit) {
        submit.disabled = true;
        submit.textContent = "Pracuji…";
      }
      if (toggleInput) toggleInput.disabled = true;
      const isAsk = form.dataset.kind === "ask";
      const response = await fetch(form.dataset.api, {
        method: form.dataset.method || "POST",
        headers: {
          "content-type": "application/json",
          ...(isAsk ? { accept: "application/x-ndjson" } : {}),
        },
        body: JSON.stringify(body),
      });
      if (isAsk && form.dataset.render) {
        const target = document.querySelector(form.dataset.render);
        await renderAskStream(response, target);
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Požadavek selhal.");
      if (form.dataset.render) {
        const target = document.querySelector(form.dataset.render);
        if (form.dataset.kind === "search") {
          const warnings = (result.warnings || []).map((warning) =>
            `<p class="danger">${escapeHtml(warning)}</p>`
          ).join("");
          const matches = (result.results || []).map((item) =>
            `<article class="card"><h3>${escapeHtml(item.episodeTitle)}</h3>
              <span class="status relevance-${escapeHtml(item.relevance)}">${
              item.relevance === "high"
                ? "vysoká shoda"
                : item.relevance === "medium"
                ? "střední shoda"
                : "nižší shoda"
            }</span>
              <a href="/episodes/${encodeURIComponent(item.episodeId)}?at=${
              Number(item.startSeconds)
            }">
                Přehrát od ${formatTime(item.startSeconds)}</a>
              <p>${escapeHtml(item.text)}</p></article>`
          ).join("");
          target.innerHTML = warnings + (matches ||
            `<p class="muted">Nic nebylo nalezeno. Zkuste zrušit filtr osoby, použít přesná slova nebo širší souvislosti.</p>`);
        } else {
          target.textContent = JSON.stringify(result, null, 2);
        }
      } else if (result.podcastId) {
        location.href = `/podcasts/${result.podcastId}`;
      } else {
        location.reload();
      }
    } catch (error) {
      if (toggleInput?.dataset.previousChecked) {
        toggleInput.checked = toggleInput.dataset.previousChecked === "true";
      }
      alert(error.message);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
      if (toggleInput) {
        toggleInput.disabled = false;
        delete toggleInput.dataset.previousChecked;
      }
    }
  });
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);

const formatTime = (value) => {
  const seconds = Math.max(0, Math.floor(Number(value)));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
};

const formatEstimate = (milliseconds) => {
  const totalMinutes = Math.max(0, Math.round(Number(milliseconds) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours} h${minutes ? ` ${minutes} min` : ""}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days} d${hours ? ` ${hours} h` : ""}`;
};

const automationStatusHtml = (status) => {
  const processed = Math.max(0, Number(status.processedCount) || 0);
  const remaining = Math.max(0, Number(status.remainingCount) || 0);
  const failed = Math.max(0, Number(status.failedCount) || 0);
  const inProgress = Math.max(0, Number(status.inProgressCount) || 0);
  const unavailable = Math.max(0, Number(status.unavailableCount) || 0);
  const sampleCount = Math.max(0, Number(status.sampleCount) || 0);
  const estimate = remaining === 0
    ? `<p class="automation-estimate automation-complete">Všechny dostupné epizody jsou hotové.</p>`
    : `<p class="automation-estimate">Odhad zbývající aktivní práce:
      <strong>${escapeHtml(formatEstimate(status.estimatedRemainingMs))}</strong></p>`;
  const estimateSource = status.source === "history"
    ? `Průměr z posledních ${sampleCount} hotových epizod: ${
      escapeHtml(formatEstimate(status.averageEpisodeDurationMs))
    } na epizodu.`
    : `Zatím bez historie; počítám orientačně ${
      escapeHtml(formatEstimate(status.averageEpisodeDurationMs))
    } na epizodu.`;
  return `<div class="automation-status-stats">
      <span><strong>${processed}</strong><small>hotovo</small></span>
      <span><strong>${remaining}</strong><small>zbývá</small></span>
      <span><strong>${inProgress}</strong><small>ve frontě / běží</small></span>
    </div>
    ${estimate}<small class="automation-estimate-source">${escapeHtml(estimateSource)}
      Odhad nezahrnuje budoucí čekání ve frontě.</small>
    ${
    failed
      ? `<small class="automation-status-warning">${failed} epizod s chybou vyžaduje ruční opakování.</small>`
      : ""
  }
    ${
    unavailable
      ? `<small class="automation-status-warning">${unavailable} epizod nelze stáhnout, protože už nejsou v RSS.</small>`
      : ""
  }`;
};

async function loadAutomationStatus(control) {
  if (control.dataset.loading === "true") return;
  const loadedAt = Number(control.dataset.loadedAt) || 0;
  if (Date.now() - loadedAt < 30_000) return;
  const content = control.querySelector("[data-automation-status-content]");
  if (!content) return;
  control.dataset.loading = "true";
  content.textContent = "Načítám stav automatizace…";
  try {
    const response = await fetch(control.dataset.endpoint, {
      headers: { accept: "application/json" },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Požadavek selhal.");
    content.innerHTML = automationStatusHtml(result);
    control.dataset.loadedAt = String(Date.now());
  } catch (_error) {
    content.innerHTML = '<span class="danger">Stav se nepodařilo načíst. Zkuste to znovu.</span>';
  } finally {
    delete control.dataset.loading;
  }
}

for (const control of document.querySelectorAll("[data-automation-status]")) {
  loadAutomationStatus(control);
}

const jobProgress = (job) => {
  if (job.progressPercent === null || job.progressPercent === undefined) {
    return escapeHtml(job.progressMessage || "—");
  }
  const percent = Math.round(Number(job.progressPercent));
  const count = job.progressCurrent !== null && job.progressCurrent !== undefined &&
      job.progressTotal !== null && job.progressTotal !== undefined
    ? `${escapeHtml(job.progressCurrent)}/${escapeHtml(job.progressTotal)}`
    : "";
  return `<div class="progress" role="progressbar" aria-valuenow="${percent}"
    aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>
    <small>${percent} % ${count}${count ? " · " : ""}${
    escapeHtml(job.progressMessage || "")
  }</small>`;
};

const jobRelation = (job) => {
  if (job.episodeId) {
    return `<a href="/episodes/${encodeURIComponent(job.episodeId)}">${
      escapeHtml(job.episodeTitle)
    }</a><small class="muted">${escapeHtml(job.podcastName || "")}</small>`;
  }
  if (job.podcastId) {
    return `<a href="/podcasts/${encodeURIComponent(job.podcastId)}">${
      escapeHtml(job.podcastName)
    }</a>`;
  }
  return `${escapeHtml(job.entityType)} · ${escapeHtml(job.entityId)}`;
};

const jobQueueBadge = (job) => {
  const queue = job.queue || (job.type === "DOWNLOAD_AUDIO" ? "download" : "processing");
  return queue === "download"
    ? '<span class="badge badge-info">Stahování</span>'
    : '<span class="badge badge-neutral">Zpracování</span>';
};

const jobDuration = (job) => {
  const accumulatedMs = Math.max(0, Number(job.processingDurationMs) || 0);
  const attempts = Math.max(0, Number(job.attempts) || 0);
  if (job.status === "queued" && attempts === 0) return "—";
  const activeStartedAt = Date.parse(job.activeStartedAt || "");
  const activeMs = job.status === "running" && Number.isFinite(activeStartedAt)
    ? Math.max(0, Date.now() - activeStartedAt)
    : 0;
  const label = job.status === "running"
    ? "Aktivně"
    : job.status === "queued"
    ? "Dosud aktivně"
    : "Trvalo";
  return `<span data-job-duration data-status="${escapeHtml(job.status)}"
    data-processing-duration-ms="${accumulatedMs}"
    data-active-started-at="${escapeHtml(job.activeStartedAt || "")}">${label} ${
    formatTime((accumulatedMs + activeMs) / 1000)
  }</span>`;
};

const refreshJobDurations = () => {
  for (const duration of document.querySelectorAll("[data-job-duration]")) {
    if (duration.dataset.status !== "running") continue;
    const accumulatedMs = Math.max(0, Number(duration.dataset.processingDurationMs) || 0);
    const activeStartedAt = Date.parse(duration.dataset.activeStartedAt || "");
    const activeMs = Number.isFinite(activeStartedAt)
      ? Math.max(0, Date.now() - activeStartedAt)
      : 0;
    duration.textContent = `Aktivně ${formatTime((accumulatedMs + activeMs) / 1000)}`;
  }
};

const jobsTable = document.querySelector("[data-live-jobs]");
if (jobsTable) {
  const refreshJobs = async () => {
    if (document.hidden) return;
    const response = await fetch("/api/jobs");
    if (!response.ok) return;
    const jobs = await response.json();
    jobsTable.querySelector("tbody").innerHTML = jobs.map((job) =>
      `<tr><td>${jobRelation(job)}</td><td>${jobQueueBadge(job)}</td>
      <td>${escapeHtml(job.type)}</td>
      <td>${escapeHtml(job.status)}</td><td>${jobProgress(job)}</td>
      <td>${jobDuration(job)}</td>
      <td>${escapeHtml(job.attempts)}/${escapeHtml(job.maxAttempts)}</td>
      <td class="danger">${escapeHtml(job.error || "")}</td></tr>`
    ).join("");
  };
  setInterval(() => refreshJobs().catch(() => undefined), 3000);
  setInterval(refreshJobDurations, 1000);
}

const initialSeek = Number(new URL(location.href).searchParams.get("at"));
const audio = document.querySelector("audio");
if (audio && Number.isFinite(initialSeek) && initialSeek > 0) {
  audio.addEventListener("loadedmetadata", () => audio.currentTime = initialSeek, { once: true });
}
