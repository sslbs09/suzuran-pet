(function () {
  "use strict";
  const api = window.petAPI;
  const status = document.getElementById("formal-memory-status");
  const history = document.getElementById("formal-memory-history");
  const state = document.getElementById("formal-memory-state");
  const refresh = document.getElementById("formal-memory-refresh");
  const legacyRole = document.getElementById("legacy-memory-role");
  const legacyEditor = document.getElementById("legacy-memory-editor");
  if (!api || !status || !history || !state || !refresh) return;
  let view = null;
  let busy = false;
  let message = null;
  let legacyKey = "set.formalMemLegacyUnknown";
  const L = (key, params) => window.I18N.t(key, params);
  function tell(key, params) { message = { key, params }; status.textContent = L(key, params); }
  const labels = { active: "set.formalMemActive", superseded: "set.formalMemSuperseded", retracted: "set.formalMemRetracted", recorded: "set.formalMemRecorded" };
  const fieldNames = { sharedMilestones: "共同里程碑", exam: "考试", status: "状态", completed: "已完成",
    active: "进行中", sharedHistory: "共同历史", meaningfulExperienceCount: "有意义经历数", sourceExperienceId: "来源记录",
    lastMeaningfulExperienceId: "最近来源记录", updatedAt: "更新时间", sharedActivities: "共同活动", observationBooklet: "观察手账",
    entryCount: "条目数", sharedEntryCount: "共同条目数", lastEntryExperienceId: "最近条目来源", startedTogetherExperienceId: "共同开始来源" };
  function element(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  function button(text, action) { const el = element("button", text); el.type = "button"; el.dataset.action = action; return el; }
  function readableState(value, path) {
    if (value === null || typeof value !== "object") return [path + "：" + (fieldNames[value] || String(value))];
    return Object.entries(value).flatMap(([key, item]) => readableState(item, path + " / " + (fieldNames[key] || key)));
  }
  function renderView() {
    if (!view) return;
    history.replaceChildren(); state.replaceChildren();
    for (const entry of view.entries) {
      const row = element("div"); row.dataset.memoryId = entry.id;
      row.style.cssText = "padding:10px 0;border-bottom:1px solid var(--ui-line);overflow-wrap:anywhere;";
      row.append(element("div", entry.summary));
      const meta = element("small", L("set.formalMemMeta", { type: entry.type,
        status: L(labels[entry.status]), time: new Date(entry.timestamp).toLocaleString(window.I18N.lang()) }));
      meta.style.cssText = "display:block;color:var(--ui-muted);margin:4px 0;";
      row.append(meta);
      if (entry.targetExperienceId) row.append(element("small", L("set.formalMemTarget", { id: entry.targetExperienceId })));
      if (entry.status === "active") {
        const actions = element("div"); actions.style.cssText = "display:flex;gap:6px;margin-top:6px;";
        const correct = button(L("set.formalMemCorrect"), "correct");
        const retract = button(L("set.formalMemRetract"), "retract");
        correct.disabled = retract.disabled = busy;
        correct.addEventListener("click", () => {
          const editor = element("textarea"); editor.value = entry.summary; editor.maxLength = 4000;
          editor.setAttribute("aria-label", L("set.formalMemReplacement"));
          editor.style.cssText = "width:100%;min-height:60px;box-sizing:border-box;margin:6px 0;";
          const save = button(L("set.formalMemSave"), "save"); const cancel = button(L("set.cancelShort"), "cancel");
          row.append(editor, save, cancel); correct.disabled = true;
          save.addEventListener("click", () => change(entry, "correct", editor.value, save));
          cancel.addEventListener("click", () => renderView());
          editor.focus();
        });
        retract.addEventListener("click", () => change(entry, "retract", undefined, retract));
        actions.append(correct, retract); row.append(actions);
      }
      history.append(row);
    }
    if (!view.entries.length) history.append(element("p", L("set.formalMemEmpty")));
    const lines = [...readableState(view.state, "State"), ...readableState(view.relationship, "Relationship")];
    for (const line of lines) state.append(element("p", line));
    if (!lines.length) state.append(element("p", L("set.formalMemEmptyDerived")));
  }
  async function inspect() {
    refresh.disabled = true;
    try {
      const result = await api.inspectFormalMemory();
      if (!result || !result.ok || !result.memory) {
        history.replaceChildren(); state.replaceChildren(); view = null;
        const disabled = result && result.status === "FORMAL_DISABLED";
        tell(disabled ? "set.formalMemDisabled" : "set.formalMemReadFailed");
        // Only a confirmed disabled mode enables the global legacy editor.
        legacyEditor.hidden = !disabled;
        legacyKey = disabled ? "set.formalMemLegacyActive" : "set.formalMemLegacyUnknown";
        legacyRole.textContent = L(legacyKey);
        return false;
      }
      view = result.memory;
      legacyEditor.hidden = true;
      legacyKey = "set.formalMemLegacySuppressed";
      legacyRole.textContent = L(legacyKey);
      renderView();
      tell("set.formalMemStats", { id: view.instanceId, n: view.entries.length, active: view.entries.filter((e) => e.status === "active").length });
      return true;
    } catch {
      view = null; history.replaceChildren(); state.replaceChildren(); legacyEditor.hidden = true;
      tell("set.formalMemReadFailed");
      return false;
    } finally { refresh.disabled = false; }
  }
  async function change(entry, action, text, source) {
    if (busy || !view) return;
    if (action === "correct" && !text.trim()) { tell("set.formalMemNeedText"); return; }
    const instanceId = view.instanceId;
    busy = true; source.disabled = true; refresh.disabled = true;
    try {
      const result = await api.controlFormalMemory({ instanceId, targetExperienceId: entry.id, action, ...(action === "correct" ? { text } : {}) });
      if (!result || !result.ok) {
        tell("set.formalMemNotSaved");
        return;
      }
      if (await inspect()) tell("set.formalMemSaved", { id: instanceId });
      else tell("set.formalMemSavedReadFailed");
    } catch { tell("set.formalMemNotSaved"); }
    finally { busy = false; source.disabled = false; refresh.disabled = false;
      history.querySelectorAll("button").forEach((item) => { item.disabled = false; }); }
  }
  refresh.addEventListener("click", () => { if (!busy) inspect(); });
  legacyEditor.hidden = true;
  let initialized = false;
  window.I18N.onChange(() => {
    if (!initialized) { initialized = true; inspect(); return; }
    // Locale changes only redraw presentation; preserve an open edit buffer.
    if (!busy && !history.querySelector("textarea")) renderView();
    if (message) status.textContent = L(message.key, message.params);
    legacyRole.textContent = L(legacyKey);
  });
})();
