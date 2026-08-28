"use strict";

/**
 * 托盘菜单构建（模块化第二步）。
 * 纯函数：读 deps（配置/状态/动作函数/常量）→ 返回 Electron MenuItem 模板数组。
 * 所有可变状态与动作由 main.js 持有并经 deps 注入，本模块无副作用、可独立测试。
 * 渲染模式联动：Spine 显示行走/皮肤/动作/散步速度；2.5D 显示 2.5D 开关/皮肤/PSD 工具；GIF 两者都不显示。
 */
function buildTrayItems(deps) {
  const {
    cfg, lang, i18n, zcodeOn, forcedMode,
    isWindowVisible, toggleWindow, setMode, setTts, setRate, setSpeakJa, setWalking,
    detectSpineModels, skinParseDir, SPINE_CN, SKIN_CHAR_NAMES, SKIN_PERSON_NAMES, setSpineSkin,
    sendToRenderer, setPetLayer, openPsdWindow, rigSkinList, setRigSkin,
    setDimMode, sitOnTaskbar, setScale, clampScale, setWalkSpeed, setCatToy,
    setFileGuard,
    openSchedule, openSettings, openMoodManager, openVoiceStudio, openTtsGuide, openQuickstart, openHelp, openAddChar,
    reloadPersona, openConfigPath, openPersonaPath, quitApp
  } = deps;

  const modeLabel = !zcodeOn ? i18n.t(lang, "tray.modeChat")
    : forcedMode === "zcode" ? i18n.t(lang, "tray.modeZcode")
    : forcedMode === "chat" ? i18n.t(lang, "tray.modeChat") + i18n.t(lang, "tray.clickAutoSuffix")
    : i18n.t(lang, "tray.modeAuto");
  const ttsOn = !!(cfg.tts || {}).enabled;
  const rate = (cfg.tts || {}).rate || 0.9;
  const scale = clampScale((cfg.window || {}).scale);
  const speakJa = !!((cfg.ttsGenie || {}).speakJa);
  const walkingOn = !!cfg.walking && cfg.renderMode === "spine";
  const rateWord = rate <= 0.85 ? "tray.rateWordSlow" : rate <= 0.95 ? "tray.rateWordSlight" : rate >= 1.1 ? "tray.rateWordFast" : "tray.rateWordNormal";
  const sizeWord = scale <= 0.8 ? "tray.sizeWordSmall" : scale >= 1.6 ? "tray.sizeWordXLarge" : scale >= 1.2 ? "tray.sizeWordLarge" : "tray.sizeWordStandard";

  const items = [
    { label: isWindowVisible() ? i18n.t(lang, "tray.hidePet") : i18n.t(lang, "tray.showPet"), click: () => toggleWindow() },
    { type: "separator" },
    { label: modeLabel, enabled: false }
  ];
  if (zcodeOn) {
    items.push(
      { label: forcedMode === "auto" ? i18n.t(lang, "tray.forceChat") : forcedMode === "chat" ? i18n.t(lang, "tray.restoreAuto") : i18n.t(lang, "tray.switchChat"), click: () => setMode(forcedMode === "chat" ? "auto" : "chat") },
      { label: forcedMode === "auto" ? i18n.t(lang, "tray.forceZcode") : forcedMode === "zcode" ? i18n.t(lang, "tray.restoreAuto") : i18n.t(lang, "tray.switchTask"), click: () => setMode(forcedMode === "zcode" ? "auto" : "zcode") }
    );
  }
  items.push(
    { type: "separator" },
    { label: ttsOn ? i18n.t(lang, "tray.voiceOn") : i18n.t(lang, "tray.voiceOff"), click: () => setTts(!ttsOn) },
    { label: i18n.t(lang, "tray.rateLabel") + i18n.t(lang, rateWord), enabled: false },
    { label: i18n.t(lang, "tray.rateSlow"), type: "radio", checked: rate <= 0.85, click: () => setRate(0.85) },
    { label: i18n.t(lang, "tray.rateSlight"), type: "radio", checked: rate > 0.85 && rate <= 0.95, click: () => setRate(0.9) },
    { label: i18n.t(lang, "tray.rateNormal"), type: "radio", checked: rate > 0.95 && rate < 1.1, click: () => setRate(1.0) },
    { label: i18n.t(lang, "tray.rateFast"), type: "radio", checked: rate >= 1.1, click: () => setRate(1.1) },
    { label: speakJa ? i18n.t(lang, "tray.speakJaOn") : i18n.t(lang, "tray.speakJaOff"), click: () => setSpeakJa(!speakJa) },
    ...((cfg.renderMode === "spine") ? [{ label: walkingOn ? i18n.t(lang, "tray.walkOn") : i18n.t(lang, "tray.walkOff"), click: () => { setWalking(!cfg.walking); } }] : []),
    ...((cfg.renderMode === "spine") ? (() => { // 皮肤三层菜单：人物 > 角色（形态） > 皮肤（仅 Spine 模式）
      const models = detectSpineModels();
      const persons = new Map(); // 人物编号 → Map(角色 → {name, items})
      for (const m of models) {
        let num, chKey, skin = "";
        const dir = String(m.id).split("/")[0];
        if (m.id === "builtin" || dir === "summer" || dir === "winter") {
          num = "298"; chKey = "298_susuro";
          if (dir === "summer") skin = "summer";
          if (dir === "winter") skin = "winter";
        } else {
          const p = skinParseDir(dir);
          if (!p) continue;
          num = p.num; chKey = p.num + "_" + p.ch; skin = p.skin;
        }
        if (!persons.has(num)) persons.set(num, new Map());
        const chars = persons.get(num);
        if (!chars.has(chKey)) {
          chars.set(chKey, { name: SKIN_CHAR_NAMES[chKey] || chKey.split("_").slice(1).join("_"), items: [] });
        }
        chars.get(chKey).items.push({
          label: (() => { // 皮肤名：优先取 SPINE_CN 全名「人物·皮肤」里「·」后的部分；summer/winter 同理
            const cn = SPINE_CN[dir];
            if (skin && cn && cn.includes("·")) return cn.split("·").slice(1).join("·");
            return skin ? skin.replace(/_/g, " ") : "默认";
          })(),
          type: "radio",
          checked: (cfg.spineSkinId || "builtin") === m.id,
          click: () => setSpineSkin(m.id)
        });
      }
      const order = ["298", "002", "1001", "1037", "172", "391", "4042", "4235", "003", "1052", "254", "358", "2015", "2025"];
      const nums = [...persons.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
      });
      return [{
        label: i18n.t(lang, "tray.personLabel"),
        submenu: nums.map((num) => ({
          label: (SKIN_PERSON_NAMES[num] || {})[lang] || num,
          submenu: [...persons.get(num).entries()].map(([chKey, ch]) => ({
            label: ch.name,
            submenu: ch.items
          }))
        }))
      }];
    })() : []),
    ...((cfg.renderMode === "spine") ? [{ label: i18n.t(lang, "tray.animDemoLabel"),
      submenu: ["Relax", "Move", "Sit", "Sleep", "Interact"].map((a) => ({
        label: a, click: () => sendToRenderer("pet:play-anim", a)
      }))
    }] : []),
    { label: i18n.t(lang, "tray.layerLabel"),
      submenu: [
        { label: i18n.t(lang, "tray.layerTop"), type: "radio", checked: (cfg.layer || "top") !== "desktop", click: () => setPetLayer("top") },
        { label: i18n.t(lang, "tray.layerDesktop"), type: "radio", checked: cfg.layer === "desktop", click: () => setPetLayer("desktop") }
      ]
    },
    ...((cfg.renderMode === "rig") ? [{ label: "🧩 PSD 角色工具（v2.1）", click: () => openPsdWindow() }] : []),
    ...((cfg.renderMode === "rig") ? [(() => { // v2.2：2.5D 角色按钮开关（勾选=启用，取消=关闭；仅 2.5D 模式）
      const on = !!cfg.rigSkinId;
      return { label: "🎬 2.5D 角色：" + (on ? "开" : "关"), type: "checkbox", checked: on,
        click: (item) => {
          if (item.checked) {
            const list = rigSkinList();
            if (!list.length) { sendToRenderer("pet:toast", "请先在「🧩 PSD 角色工具」导入 PSD 皮肤"); item.checked = false; return; }
            setRigSkin(cfg.rigSkinId || list[0].id);
          } else setRigSkin("");
        } };
    })()] : []),
    ...((cfg.renderMode === "rig") ? [(() => { // v2.2：2.5D 皮肤列表（仅 2.5D 模式）
      const skins = rigSkinList();
      const sub = skins.length ? skins.map((s) => ({
        label: "🎬 " + s.id, type: "radio", checked: cfg.rigSkinId === s.id,
        click: () => setRigSkin(s.id)
      })) : [{ label: "（暂无皮肤，先导入）", enabled: false }];
      sub.push({ type: "separator" });
      sub.push({ label: "🧩 PSD 角色工具…", click: () => openPsdWindow() });
      return { label: "🎬 2.5D 皮肤", submenu: sub };
    })()] : []),
    { label: "🌗 半透明模式", type: "checkbox", checked: !!cfg.dimMode, click: () => setDimMode(!cfg.dimMode) },
    { label: "🛡️ 蜜标监控：" + (cfg.fileGuard ? "开" : "关"), type: "checkbox", checked: !!cfg.fileGuard, click: () => setFileGuard(!cfg.fileGuard) },
    { label: i18n.t(lang, "tray.sitTaskbar"), click: () => sitOnTaskbar() },
    { label: i18n.t(lang, "tray.sizeLabel") + i18n.t(lang, sizeWord), enabled: false },
    { label: i18n.t(lang, "tray.sizeSmall"), type: "radio", checked: scale <= 0.8, click: () => setScale(0.75) },
    { label: i18n.t(lang, "tray.sizeStandard"), type: "radio", checked: scale > 0.8 && scale < 1.2, click: () => setScale(1.0) },
    { label: i18n.t(lang, "tray.sizeLarge"), type: "radio", checked: scale >= 1.2 && scale < 1.6, click: () => setScale(1.25) },
    { label: i18n.t(lang, "tray.sizeXLarge"), type: "radio", checked: scale >= 1.6, click: () => setScale(1.5) },
    ...((cfg.renderMode === "spine") ? [{ label: "🐈 逗猫棒：" + (cfg.catToy ? "开" : "关"), type: "checkbox", checked: !!cfg.catToy,
      click: () => setCatToy(!cfg.catToy)
    }] : []),
    ...((cfg.renderMode === "spine") ? [{ label: "🚶 散步速度", submenu: [
      { label: "🐢 慢速", type: "radio", checked: (cfg.walkSpeedMul || 1) <= 0.8, click: () => setWalkSpeed(0.6) },
      { label: "🚶 标准", type: "radio", checked: !cfg.walkSpeedMul || ((cfg.walkSpeedMul > 0.8) && (cfg.walkSpeedMul < 1.4)), click: () => setWalkSpeed(1) },
      { label: "🏃 快速", type: "radio", checked: cfg.walkSpeedMul >= 1.4 && cfg.walkSpeedMul < 2.2, click: () => setWalkSpeed(1.6) },
      { label: "⚡ 飞快", type: "radio", checked: cfg.walkSpeedMul >= 2.2, click: () => setWalkSpeed(2.5) }
    ]} ] : []),
    { type: "separator" },
    { label: "📅 日程安排", click: () => openSchedule() },
    { label: i18n.t(lang, "tray.settings"), click: () => openSettings() },
    { label: i18n.t(lang, "tray.moodManager"), click: () => openMoodManager() },
    { label: i18n.t(lang, "tray.voiceStudio"), click: () => openVoiceStudio() },
    { label: i18n.t(lang, "tray.ttsGuide"), click: () => openTtsGuide() },
    { label: i18n.t(lang, "tray.reloadPersona"), click: () => reloadPersona() },
    { label: i18n.t(lang, "tray.quickstart"), click: () => openQuickstart() },
    { label: i18n.t(lang, "tray.help"), click: () => openHelp() },
    { label: "➕ 添加人物…", click: () => openAddChar() },
    { label: i18n.t(lang, "tray.openConfig"), click: () => openConfigPath() },
    { label: i18n.t(lang, "tray.openPersona"), click: () => openPersonaPath() },
    { type: "separator" },
    { label: i18n.t(lang, "tray.exit"), click: () => quitApp() }
  );
  return items;
}

module.exports = { buildTrayItems };
