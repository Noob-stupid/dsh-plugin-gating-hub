window.__ModuleLoader__.load({
	id: "@noob-stupid/dsh-plugin-console",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region styles
		const css = ".pc_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}.pc_section h3{margin:0;font-size:13px;font-weight:600;line-height:20px}.pc_message{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}.pc_messageRow{display:flex;align-items:center;gap:10px}.pc_spinner{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:pcspin 1s linear infinite;flex:none}@keyframes pcspin{to{transform:rotate(360deg)}}.pc_message[data-error=true]{color:var(--dsw-alias-state-error-primary)}.pc_message[data-warn=true]{color:var(--dsw-alias-state-warning-primary)}.pc_list{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none;display:grid}.pc_row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;padding:10px 12px;flex-direction:column;gap:6px;display:flex}.pc_rowTop{align-items:center;gap:8px;display:flex}.pc_name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.pc_tag{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;flex:none}.pc_tag[data-enabled=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.pc_tag[data-user=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_tag[data-pending=true]{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_status[data-pending=true]{color:var(--dsw-alias-state-warning-primary)}.pc_toggle[data-pending=true]{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_tag[data-skill=true]{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_tag[data-system=true]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}.pc_tag[data-disabled=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.pc_tag[data-suite=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.pc_tag[data-error=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.pc_tabGroup{display:inline-flex;gap:4px;align-items:center}.pc_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;gap:6px;display:flex;align-items:center}.pc_phase[data-phase=failed]{color:var(--dsw-alias-state-error-primary)}.pc_phase[data-phase=active]{color:var(--dsw-alias-state-success-primary)}.pc_toggle{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;cursor:pointer;border-radius:6px;padding:4px 12px;align-self:flex-start}.pc_toggle:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}.pc_toggle:disabled{opacity:.5;cursor:default}.pc_search{gap:8px;display:flex}.pc_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:34px;flex:1;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 12px;font-size:13px}.pc_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}.pc_search button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;border-radius:8px;padding:0 14px;font-size:13px}.pc_search button:hover{border-color:var(--dsw-alias-state-business-primary)}.pc_market{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}.pc_item{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;padding:10px 12px;flex-direction:column;gap:6px;display:flex}.pc_itemTop{align-items:center;gap:8px;display:flex}.pc_itemTop a{color:var(--dsw-alias-state-business-primary);font-size:13px;font-weight:600;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pc_stars{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}.pc_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}.pc_item button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;cursor:pointer;border-radius:6px;padding:3px 10px;align-self:flex-start;font-size:12px}.pc_item button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}.pc_item button:disabled{opacity:.5;cursor:default}.pc_detail{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 12px;flex-direction:column;gap:6px;display:flex}.pc_status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}.pc_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0}.pc_marketHead{display:flex;align-items:center;justify-content:space-between;gap:10px}.pc_descWrap{flex-direction:column;display:flex}.pc_installedHead{display:flex;align-items:center;gap:10px}.pc_backTopWrap{position:fixed;top:56px;right:20px;z-index:100;display:flex;flex-direction:column;gap:8px}.pc_backTop{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(22,27,34,.72);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;backdrop-filter:blur(4px);opacity:.7}.pc_backTop:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary)}.pc_descTopbar{display:flex;justify-content:flex-end;margin:2px 0}.pc_ghpill{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 10px;font-size:11px;line-height:18px}.pc_ghpill[data-on=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.pc_extraBtn{opacity:.75;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;cursor:pointer;border-radius:6px;padding:4px 10px;font-size:12px;line-height:16px;flex:none;transition:opacity .15s ease,border-color 1.5s ease,color 1.5s ease}.pc_extraBtn:hover{opacity:1}.pc_extraBtn[data-active=true]{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_extraBtn[data-flash=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_view{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;cursor:pointer;border-radius:6px;padding:2px 10px;font-size:12px;line-height:18px;flex:none}.pc_floatPanel{position:fixed;left:20px;top:50%;transform:translateY(-50%);width:340px;max-height:75vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:50;flex-direction:column;gap:8px;display:flex}.pc_refresh{position:sticky;bottom:14px;align-self:flex-end;margin-top:8px;z-index:60;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_refresh:hover{opacity:.9}.pc_date{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none}.pc_searchInner{position:relative;flex:1;display:flex;align-items:center;min-width:0}.pc_searchInner input{padding-right:32px;width:100%}.pc_starBtn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:4px 8px;border-radius:6px;opacity:.75;transition:opacity .15s ease;flex:none}.pc_starBtn:hover{opacity:1}.pc_starBtn[data-active=true]{opacity:1;color:var(--dsw-alias-state-business-primary)}.pc_restartBtn{position:fixed;right:20px;top:50%;transform:translateY(-50%);z-index:60;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_restartBtn:hover{opacity:.9}.pc_relaunchFloat{position:fixed;left:20px;top:50%;transform:translateY(-50%);z-index:70;opacity:.85;border:1px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_relaunchFloat:hover{opacity:1}.pc_aiToggle{position:fixed;right:20px;top:20px;z-index:70;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_aiToggle:hover{opacity:1}.pc_aiToggle[data-active=true]{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_sourcesFloat{position:fixed;right:20px;top:104px;z-index:70;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_sourcesFloat:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_modeFloat{position:fixed;right:20px;top:204px;z-index:70;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_modeFloat:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_modeFloat[data-mode=true]{opacity:1;border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_trashBtn{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:16px;padding:2px 6px;flex:none;display:flex;align-items:center;border-radius:6px;transition:color .15s ease}.pc_trashBtn:hover{color:var(--dsw-alias-state-error-primary)}.pc_consentRemember{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}.pc_modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center}.pc_modalCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:16px 18px;width:min(760px,calc(100vw - 64px));max-height:calc(100vh - 96px);overflow-y:auto;overscroll-behavior:contain;flex-direction:column;gap:10px;display:flex;box-shadow:0 12px 32px rgba(0,0,0,.25)}.pc_modalCard::-webkit-scrollbar{width:8px}.pc_modalCard::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}.pc_srcUrl{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%}.pc_accWrap{display:flex;flex-direction:column;gap:8px}.pc_acc{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}.pc_accHead{width:100%;text-align:left;background:transparent;border:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;line-height:20px;padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:6px}.pc_accHead:hover{background:var(--dsw-alias-bg-layer-3)}.pc_accHead[data-open=true]{border-bottom:1px solid var(--dsw-alias-border-l2)}.pc_accBody{padding:10px 12px;display:flex;flex-direction:column;gap:8px}.pc_ghpill{background:0 0;cursor:pointer}.pc_ghwrap{position:relative;display:inline-flex}.pc_sourceMenu{position:absolute;right:0;top:calc(100% + 6px);z-index:90;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:4px;flex-direction:column;display:flex;min-width:120px;box-shadow:0 8px 24px rgba(0,0,0,.18)}.pc_sourceOpt{border:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:6px 10px;text-align:left;font-size:12px;line-height:16px}.pc_sourceOpt[data-active=true]{color:var(--dsw-alias-state-business-primary);font-weight:600}.pc_sourceOpt:hover{background:var(--dsw-alias-bg-layer-3)}.pc_aiEmpower{position:fixed;right:20px;top:48px;z-index:70;opacity:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_aiEmpower:hover{opacity:.9}.pc_aiEmpower[data-busy=true]{opacity:1;border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_aiEmpower[data-active=true]{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_compCard{position:fixed;left:8px;top:20px;width:320px;max-height:70vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:45;flex-direction:column;gap:8px;display:flex}.pc_compCard .pc_rowTop{flex-wrap:wrap}.pc_compCard .pc_toggle{padding:3px 8px;font-size:11px}.pc_compCard[data-hidden=true]{display:none}.pc_compDrop{background:rgba(24,28,34,.92);backdrop-filter:blur(6px);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);flex-direction:column;display:flex;gap:2px}.pc_compDropRow{border:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:6px 8px;text-align:left;font-size:12px;line-height:16px;flex-direction:column;display:flex;gap:2px}.pc_compDropRow:hover{background:var(--dsw-alias-bg-layer-2)}.pc_compDropUrl{color:var(--dsw-alias-label-tertiary);font-size:11px;word-break:break-all}.pc_compToggle{position:fixed;left:336px;top:20px;z-index:46;opacity:.55;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:rgba(22,27,34,.72);font:inherit;cursor:pointer;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;line-height:1;backdrop-filter:blur(4px);transition:opacity .15s ease}.pc_compToggle:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary)}.pc_toolbarMain{position:fixed;right:70px;top:20px;z-index:71;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:border-color .15s ease}.pc_toolbarMain:hover{border-color:var(--dsw-alias-state-business-primary)}.pc_toolbarMain[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_toolbarGroup{position:fixed;right:70px;top:56px;z-index:70;flex-direction:column;gap:8px;display:flex;transform-origin:top right;animation:pcDrawerIn .3s cubic-bezier(.34,1.56,.64,1)}@media (max-width:1160px){.pc_toolbarMain{top:104px}.pc_toolbarGroup{top:140px}.pc_aiToggle{top:104px}.pc_aiEmpower{top:132px}.pc_sourcesFloat{top:188px}.pc_modeFloat{top:288px}}@keyframes pcDrawerIn{from{opacity:0;transform:translateX(28px) scale(.94)}to{opacity:1;transform:translateX(0) scale(1)}}.pc_toolItem{opacity:.85;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;transition:opacity .15s ease}.pc_toolItem:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary)}.pc_toolItem[data-active=true]{opacity:1;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.pc_toolItem[data-mode=true]{opacity:1;border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}.pc_switch{width:34px;height:18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;flex:none;transition:background .15s ease,border-color .15s ease}.pc_switch:hover{border-color:var(--dsw-alias-state-business-primary)}.pc_switch[data-on=true]{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.pc_switchKnob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s ease}.pc_switch[data-on=true] .pc_switchKnob{left:18px}.pc_aiSpinner{width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:pcspin 1s linear infinite;flex:none}.pc_aiSpinBtn{position:fixed;right:152px;top:20px;z-index:71;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px}.pc_aiSpinBtn:hover{border-color:var(--dsw-alias-state-business-primary)}.pc_tag[data-bad=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.pc_progress{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;font-variant-numeric:tabular-nums}.pc_consentCard{border:2px solid var(--dsw-alias-state-warning-primary);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:12px 14px;flex-direction:column;gap:8px;display:flex;box-shadow:0 0 0 3px rgba(255,176,32,.10)}.pc_consentCountdown{margin-left:auto;flex:none;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warning-primary)}.pc_consentApprove{border:1px solid var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary);background:0 0;font:inherit;font-weight:600;cursor:pointer;border-radius:6px;padding:4px 12px;align-self:flex-start}.pc_consentApprove:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}";
		const tagId = "@noob-stupid/dsh-plugin-console/PluginConsoleTab.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@noob-stupid/dsh-plugin-console";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			section: "pc_section",
			marketHead: "pc_marketHead",
			installedHead: "pc_installedHead",
			backTop: "pc_backTop",
			backTopWrap: "pc_backTopWrap",
			spinner: "pc_spinner",
			ghpill: "pc_ghpill",
			descWrap: "pc_descWrap",
			descTopbar: "pc_descTopbar",
			message: "pc_message",
			list: "pc_list",
			row: "pc_row",
			rowTop: "pc_rowTop",
			name: "pc_name",
			tag: "pc_tag",
			meta: "pc_meta",
			phase: "pc_phase",
			toggle: "pc_toggle",
			search: "pc_search",
			extraBtn: "pc_extraBtn",
			view: "pc_view",
			floatPanel: "pc_floatPanel",
			refresh: "pc_refresh",
			restartBtn: "pc_restartBtn",
			relaunchFloat: "pc_relaunchFloat",
			aiToggle: "pc_aiToggle",
			aiEmpower: "pc_aiEmpower",
			compCard: "pc_compCard",
			compDrop: "pc_compDrop",
			compDropRow: "pc_compDropRow",
			compDropUrl: "pc_compDropUrl",
			compToggle: "pc_compToggle",
			toolbarMain: "pc_toolbarMain",
			toolbarGroup: "pc_toolbarGroup",
			toolItem: "pc_toolItem",
			aiSpinner: "pc_aiSpinner",
			aiSpinBtn: "pc_aiSpinBtn",
			pcSwitch: "pc_switch",
			pcSwitchKnob: "pc_switchKnob",
			sourcesFloat: "pc_sourcesFloat",
			srcUrl: "pc_srcUrl",
			accWrap: "pc_accWrap",
			acc: "pc_acc",
			accHead: "pc_accHead",
			accBody: "pc_accBody",
			modeFloat: "pc_modeFloat",
			trashBtn: "pc_trashBtn",
			consentRemember: "pc_consentRemember",
			consentCard: "pc_consentCard",
			consentCountdown: "pc_consentCountdown",
			consentApprove: "pc_consentApprove",
			progress: "pc_progress",
			modalBackdrop: "pc_modalBackdrop",
			modalCard: "pc_modalCard",
			ghwrap: "pc_ghwrap",
			sourceMenu: "pc_sourceMenu",
			sourceOpt: "pc_sourceOpt",
			date: "pc_date",
			searchInner: "pc_searchInner",
			starBtn: "pc_starBtn",
			tabGroup: "pc_tabGroup",
			market: "pc_market",
			item: "pc_item",
			itemTop: "pc_itemTop",
			stars: "pc_stars",
			desc: "pc_desc",
			detail: "pc_detail",
			status: "pc_status",
			note: "pc_note",
		};
		//#endregion
		//#region locales
		const zh = {
			tab: "插件管理",
			loading: "正在读取插件…",
			error: "暂时无法读取插件。",
			retry: "重试",
			installedTitle: "已安装插件",
			marketTitle: "插件市场（GitHub）",
			marketTitleOther: "插件市场（{source}）",
			search: "搜索",
			searchPlaceholder: "搜索 GitHub 上的 dsh-plugin 插件（留空使用默认关键词）",
			searchPlaceholderOther: "搜索 {source} 上的插件（留空使用默认关键词）",
			multiSourceTitle: "多源汇总：GitHub + 全部自定义源并行搜索（Gitee 直装模式不参与）",
			multiSourceToggle: "多源搜索开关",
			multiEmpty: "所有搜索源都没有找到匹配的插件。",
			giteeRepoPlaceholder: "输入 Gitee 仓库名（owner/repo，如 oschina/git-osc）",
			giteeEmpty: "Gitee 官方搜索接口已废弃：请在搜索框直接输入仓库名（owner/repo，如 oschina/git-osc）后回车",
			empty: "暂无插件。",
			on: "启用",
			off: "停用",
			enabledTag: "已启用",
			disabledTag: "已停用",
			userDisabledTag: "补丁停用",
			pendingCompatTag: "待适配",
			pendingCompatHint: "框架升级后被强制禁用：先点「检测更新」，如有新版按钮会变为「更新并适配」，点击后更新完成自动校验通过即解锁启用",
			updateAndAdapt: "更新并适配",
			familyTag: "全家桶",
			familySubs: "子包",
			familyUnlockAll: "一键启用已适配",
			familyUnlockAllTip: "对全家桶内尚未通过扫描的子包重跑源码扫描：通过即解锁启用；未通过保持禁用并给出原因",
			familyUnlockAllConfirm: "将对全家桶内尚未通过扫描的子包重跑源码扫描，通过的一键解锁启用？未通过的保持禁用。",
			familyUnlockAllDone: "已批量适配解锁",
			familyExpand: "展开",
			familyCollapse: "收起",
			familyUpdate: "全家桶版本检测",
			familyCheckUpdate: "批量检测更新",
			familyUpdateBtn: "更新",
			familyCheckUpdateTip: "检测到新版本后此处出现「更新」按钮，点击开始整包更新（含子包版本对齐与适配校验）",
			adaptUnlockBtn: "已适配，立即解锁",
			adaptUnlockHint: "已安装版本经源码扫描确认适配当前框架：立即移除禁用块并解锁启用",
			adaptUnlockDone: "已适配解锁：刷新后该行可正常启用",
			riskyEnableTitle: "强行启用不适配插件？",
			riskyEnableBody: "该插件在当前框架下被判为不适配（框架升级时已被自动禁用）。强行启用后，DSH 下次启动可能失败、需要手动处理。确认强行启用？",
			riskyEnableConfirm: "确认强行启用",
			riskyEnableCancel: "取消",
			adoptableDetected: "检测到已适配：当前版本 {version} 已通过源码扫描，点「已适配，立即解锁」即可启用（不会自动开启）",
			compatGateLabel: "兼容门",
			compatGateAutoDisable: "升级时自动禁用不适配插件",
			compatGateAutoDetect: "打开时自动检测已适配（仅提示）",
			compatGateHint: "关掉即回到纯手动：升级只提示、不动你的开关；检测也不提示，由你自己判断",
			compatGateSaved: "兼容门设置已保存",
			gateBtn: "门控",
			gateTitle: "门控：升级时自动禁用不适配插件、打开时自动检测已适配",
			gateModalTitle: "门控（兼容门总开关）",
			gatePendingInfo: "当前待适配：{n} 行（升级预扫或启动失败隔离记下的，更新插件后可一键解锁）",
			gatePendingNone: "当前没有待适配的行",
			fwFailedButUpgraded: "框架本体其实已经升到 {v} 并已生效——失败的只是脚本最后「重启服务」那一步。可点「重启服务」确认，或必要时回滚。",
			fwPanelBtn: "框架",
			fwPanelTitle: "框架升级 / 回滚",
			fwPanelCurrent: "当前版本",
			fwPanelAvailable: "可升级到 {v}",
			fwPanelUpToDate: "已是最新（latest {latest} · next {next}）",
			fwPanelCheckFailed: "版本检查失败：{err}",
			fwPanelChecking: "检查中…",
			fwPanelRecheck: "重新检查版本",
			fwPanelRefreshStatus: "刷新进度",
			fwPanelNoRecord: "还没有升级记录（这里会常驻显示最近一次升级/回滚的每一步）",
			fwPanelConfirmBody: "确认升级到 {v}？脚本会自动：备份配置 → 预扫禁用不适配行 → 停服 → 装新版 → 拉起服务；起不来会先隔离重试，最后才整包回滚。",
			fwRollbackDone: "已回滚到 {v}（当前就是快照版本，没有更早的可回）",
			migrateTip: "项目已迁移（适配当前框架）",
			migrateBtn: "迁移并适配",
			aiEmpowerFrameworkCheck: "框架适配检测",
			userForcedTag: "补丁强制启用",
			protectedTag: "受保护",
			unobserved: "未挂载",
			pending: "等待依赖",
			loadingPhase: "加载中",
			active: "已挂载",
			failed: "挂载失败",
			unloading: "卸载中",
			toggledOn: "已请求启用",
			toggledOff: "已请求停用",
			failed: "操作失败",
			view: "查看",
			install: "添加并启用",
			installing: "正在安装…",
			marketLoading: "正在搜索 GitHub…",
			marketLoadingOther: "正在搜索 {source}…",
			directOther: "通过服务端通道检索 {source} 平台（自定义源不走浏览器直连）",
			marketError: "搜索失败",
			marketEmpty: "没有找到相关项目。",
			repoLoading: "正在读取仓库信息…",
			repoError: "读取仓库信息失败",
			packageName: "npm 包名",
			dshHint: "疑似 DSH 插件",
			noPackage: "该仓库没有 package.json，无法安装",
			privateRootHint: "该仓库根包未发布到 npm（private），无法直接安装",
			subpackagesTitle: "仓库子包（可单独安装）",
			subpackagesLoading: "正在读取子包列表…",
			subpackagesError: "读取子包列表失败（网络波动时可稍后重试）",
			subpackagesEmpty: "未发现可安装的子包。",
			recentFailures: "最近安装失败",
			installed: "已安装并启用",
			installNote: "HMR 正在生效；若插件带界面，请刷新页面",
			bundleNote: "该包是 bundle 层插件（如皮肤合集），重启 DSH 服务后生效",
			direct: "（浏览器直连 GitHub；若你的浏览器打不开 GitHub，将自动回退到服务端通道）",
			details: "详情",
					expandDesc: "展开",
			collapseDesc: "收起",
			addLocal: "添加到本地",
			installingLocal: "安装中…",
			needPackage: "该仓库没有 package.json，无法直接添加",
			noDetail: "该插件没有提供说明信息。",
			versionLabel: "版本",
			repoLabel: "仓库",
			homepageLabel: "主页",
			readmeLabel: "说明摘要",
			loadingDetails: "正在读取详情…",
			githubLoggedIn: "已登录 GitHub：",
			githubCornerOut: "未登录 GitHub",
			githubLoginViaApp: "GitHub 登录",
			githubLoginOpened: "已打开 GitHub 授权窗口，请在页面上输入验证码完成授权…",
			githubLoginUnavailable: "无法使用窗口登录",
			githubLoginOrToken: "或用 Token 登录",
			githubLoginTip: "粘贴 GitHub Token 登录（fine-grained，需 read:user 权限）。登录后可用代码搜索（按子包名搜索）并提高 API 限额；也可用 dsh-github-login 插件登录。",
			githubTokenPlaceholder: "粘贴 token（ghp_… 或 github_pat_…）",
			githubLoginBtn: "登录",
			githubLoginOk: "已登录 GitHub：{login}",
			githubLoginFail: "登录失败",
			hubUpdateAvailable: "下载更新",
			cleanResiduals: "清理残余备份",
					searchInstalledPlaceholder: "搜索已安装插件（名称或 id）",
			extraFilter: "已装",
			extraFilterAll: "全部",
			extraTag: "第三方",
			extraFilterTitle: "切换：已装（后装/第三方插件）/ 全部",
			extraEmpty: "没有已装的插件（非 dsh 自带）。",
			noMatch: "没有匹配的插件。",
			loadMore: "加载更多",
			loadingMore: "加载中…",
			backToSearch: "回到搜索",
			collapseResults: "收起搜索结果",
			expandResults: "展开搜索结果",
			reloadPage: "刷新页面",
			refreshList: "刷新插件列表",
			stageLabel: "阶段",
			stagePreparing: "准备中",
			stageInstalling: "下载安装中（可离开本页，后台继续）",
			stageConfiguring: "写入启用配置",
			stageRepairing: "本地 AI 接管安装中…",
			restartService: "重启服务",
			restarting: "服务重启中，页面稍后自动恢复…",
			autoReload: "页面即将自动刷新…",
			aiRepaired: "本地 AI 已接管并完成修复，请刷新页面查看",
			deletePlugin: "删除插件（移除配置并卸载包）",
			confirmDelete: "确认删除？",
			deleting: "删除中…",
			deleteNote: "已删除插件并卸载包，正在刷新",
			deleteBundleNote: "已移除插件所属 bundle，重启服务后生效",
			pendingRestartTag: "已安装·重启后生效",
			pendingRestartHint: "包已装好，重启服务后才会出现在上面的插件列表里；现在删除可直接撤回这次安装",
			pendingRestartDelete: "撤销这次安装（删补丁行 / bundles 清单 / 包目录）",
			pendingRestartNote: "已撤销这次安装（补丁行、bundles 清单、包目录均已清理）",
			pendingRestartPartial: "撤销未完全生效，请按提示手动处理",
			aiConsentText: "常规安装通道均已尝试失败。下一步将让本地 AI 接管安装——这会调用 DeepSeek API 模型，可能产生 API 费用。是否继续？",
			aiConsentNotifyTitle: "插件安装需要授权",
			aiConsentApprove: "同意，继续（可能产生费用）",
			aiConsentDecline: "取消",
			aiConsentCardTitle: "⚠ 需要你的授权：本地 AI 兜底",
			aiConsentCountdown: "剩余",
			aiConsentTimeoutNote: "超过 {min} 分钟不做选择将自动取消（不会产生任何费用）",
			aiConsentLastError: "确定性通道最后一个错误",
			aiConsentTopHint: "⚠ 有安装任务在等你授权：确定性安装通道都失败了，可使用本地 AI 兜底（会调用模型 API 产生费用）——请在安装进度处选择「同意 / 取消」",
			progressSubpackage: "正在装第 {index}/{total} 个子包：{name}",
			progressSuiteClone: "正在拉取第 {index}/{total} 个子模块：{name}",
			progressSuiteAssemble: "正在装配第 {index}/{total} 个子模块：{name}",
			progressDone: "已完成（共 {total} 个）",
			aiFallbackLabel: "AI 兜底",
			aiEmpowerLabel: "AI 赋能",
			aiEmpowerTitle: "AI 赋能：读文档自动规划并部署组件；识别到服务器类组件后自动加启动/停止按钮",
			aiEmpowerSrcTitle: "输入要部署的组件（npm 包名或 GitHub 仓库，如 Noob-stupid/dsh-plugin-hub 或 @noob-stupid/dsh-plugin-console）",
			aiEmpowerPlanTitle: "AI 赋能部署计划",
			aiEmpowerType: "类型",
			aiEmpowerTypeMapping: { "pure-plugin": "纯插件", "service": "服务器组件", "config-only": "仅配置" },
			aiEmpowerSteps: "执行步骤（可勾选）",
			aiEmpowerRun: "同意并部署",
			aiEmpowerNeedSteps: "请至少勾选一个步骤；勾选后点击「同意并部署」才会执行",
			aiConfirmDeploy: "即将执行 {name} 的 {n} 个部署步骤（可能安装软件/写入配置/启动服务）。确认同意并部署？",
			aiPlanHint: "⚠️ AI 只负责规划建议——部署前需要你明确同意：勾选步骤 → 同意并部署 →（二次确认）",
			aiWorkspaceInfo: "调研工作区",
			aiEmpowerCancel: "取消",
			aiEmpowerWaiting: "等待 AI 分析文档并生成计划（约 1-5 分钟，会调用 DeepSeek API，可能产生费用）…",
			aiEmpowerExecuting: "AI 赋能执行中…",
			aiEmpowerDone: "AI 赋能部署完成",
			aiEmpowerFail: "AI 赋能失败",
			aiEmpowerLogs: "执行日志",
			aiEmpowerComponents: "已识别的服务器组件",
			compStart: "启动",
			compStop: "停止",
			compStatus: "状态",
			compOpen: "打开",
			compRunning: "运行中",
			compStopped: "未运行",
			compHealthy: "健康",
			compUnhealthy: "不健康",
			compRefresh: "刷新组件状态",
			compDropTitle: "展开所有服务器，点击打开网址",
			compNoUrl: "暂无网址",
			compCollapseTitle: "收缩组件卡片",
			compExpandTitle: "展开组件卡片",
			toolbarLabel: "功能包",
			toolbarOpenTitle: "展开功能包",
			toolbarCloseTitle: "收起功能包",
			repoLandLabel: "仓库落地",
			repoLandTitle: "仓库落地：用 Git 源「{source}」克隆任意项目到本地（~/.dsh/repos/，不限于 DSH 插件）",
			repoLandSourceUnknown: "已配置的 Git 源",
			repoLandPlaceholder: "输入 owner/repo 或仓库链接，如 deepseek-ai/deepseek-harness",
			repoLandBusy: "克隆中…（大仓库可能较慢）",
			repoLandDone: "已落地到：",
			repoLandOpenFolder: "打开文件夹",
			repoLandExists: "该仓库已存在，无需重复落地",
			repoLandDirLabel: "保存路径",
			repoLandSaveDir: "保存路径",
			repoLandList: "已落地仓库",
			repoLandRemoveConfirm: "确认删除已落地仓库 {repo}（本地目录将被删除）？",
			repoLandEntry: "仓库落地",
			repoLandLanded: "已落地",
			aiProgressTitle: "AI 赋能进行中，点击查看进度",
			compAutoTitle: "自启动：开启后随 DSH 启动自动拉起该服务器（关闭则需手动启动）",
			compActionDone: "{action}：{name}",
			noComponents: "暂无已识别的服务器组件（用 AI 赋能部署后自动出现）",
			aiFallbackTitle: "关闭后：常规通道失败将直接取消安装，不再调用模型 API（零费用）",
			aiFallbackOff: "已按设置关闭 AI 兜底，本次安装已取消（零费用）",
			aiConsentRemember: "以后不再提醒（自动同意 AI 兜底，可能产生费用；可随时在插件市场页面最底部恢复提醒）",
			aiRememberNote: "已按设置自动同意本地 AI 兜底（如需恢复弹窗提醒，请到市场底部修改）",
			aiRememberReset: "已关闭 AI 兜底弹窗提醒（点击恢复提醒）",
			consentWaiting: "等待授权确认…",
			dismissFailure: "关闭此条提示",
			sourcesBtn: "软件源",
			sourcesTitle: "软件源管理",
			sourcesDesc: "分工：① 软件源 = 下载 npm 包（安装用）；② 索引源 = 市场首页清单 JSON；③ Git 源 = 克隆仓库代码（无 npm 包时）；④ 搜索源 = 搜索时查哪个平台——搜到之后仍按 ①/③ 下载",
			sourcePrimary: "主源",
			setPrimary: "设为主源",
			registryScan: "扫描软件源",
			registryScanHint: "逐个探测每个软件源：是否可达、响应延迟、以及该源上 dsh-plugin-console 的最新版本（用于判断主源是否最优）",
			registryScanning: "正在扫描…",
			registryScanSummary: "扫描完成：{ok}/{total} 个可达",
			registryScanBest: "最新版本 {version} 来自：{name}",
			registryScanNoVersion: "该源上没有这个包",
			registryScanFail: "不可达",
			setPrimaryHint: "设为主源：优先使用它，失败时自动回退到其他源",
			editSourceHint: "编辑：修改这个源的名称与地址",
			removeSourceHint: "删除：从列表中移除这个源（不影响已安装的插件）",
			removeSource: "删除",
			sourceName: "名称",
			sourceUrl: "地址（https://…）",
			addSource: "添加",
			resetSources: "恢复默认",
			closeModal: "关闭",
			invalidSourceUrl: "软件源地址必须是 https:// 开头（或本机/私网 http://）的合法 URL",
			editSource: "编辑",
			saveSource: "保存",
			cancelEdit: "取消",
			searchSourcesTitle: "搜索源",
			searchSourcesDesc: "搜索平台（点击登录标切换）。自定义源用 URL 模板：{q}=关键词、{page}=页码",
			addSearchSource: "添加搜索源",
			indexSourcesTitle: "索引源",
			indexSourcesDesc: "市场静态索引的下载地址（主源优先，其余依次重试）。可换成公司内网自建服务——注意：索引「内容」由那份 JSON 决定，把公共索引与内网私有插件索引一并托管即可在内网浏览；想同时看到两边条目，请打开下面的「合并所有索引源」",
			indexMergeLabel: "合并所有索引源",
			indexMergeDesc: "开启后：所有索引源的结果合并去重展示（公共索引 + 公司内网私有索引同时可见）；关闭时按主→备只用一个源（内网优先，更快）",
			addIndexSource: "添加索引源",
			indexUrlPlaceholder: "索引 JSON 地址（https:// 或本机/私网 http://）",
			gitSourcesTitle: "Git 源",
			gitSourcesDesc: "克隆仓库时用的地址模板（{owner}/{repo} 占位符）。下面这个列表就是「自定义 Git 源」——内置两条是默认值，点「添加 Git 源」即可换成你自己的：Gitee = https://gitee.com/{owner}/{repo}.git；GitLab = https://gitlab.com/{owner}/{repo}.git；自建 Gitea = https://你的域名/{owner}/{repo}.git；镜像代理 = https://镜像站/https://github.com/{owner}/{repo}.git；本地裸仓库 = file:///D:/repos/{owner}/{repo}.git。主源优先，失败自动回退下一个",
			addGitSource: "添加 Git 源",
			gitUrlPlaceholder: "如 https://gitee.com/{owner}/{repo}.git",
			gitSourceBtn: "Git 源",
			marketIndexOffline: "离线数据 · 缓存于 {time}（索引源不可达，已回退上次成功结果）",
			marketIndexStale: "市场索引未加载：搜索只覆盖 GitHub 实时结果（仓库名/描述/topics），收录条目与本地索引模糊匹配都用不上",
			marketIndexRetry: "重试加载索引",
			searchLoginHint: "未登录 GitHub：代码搜索不可用（按子包名搜索需要登录）；仓库搜索仍可用",
			marketIndexFrom: "索引来源：{source}",
			marketIndexFailed: "市场索引加载失败",
			unknown: "未知",
			searchUrlPlaceholder: "URL 模板（必须含 {q}）",
			invalidSearchUrl: "搜索 URL 模板必须包含 {q} 占位符",
			headersPlaceholder: "请求头（可选）：每行一个，格式 名称: 值，如 Authorization: Bearer 令牌",
			giteeTitle: "Gitee 登录（可选）",
			giteeDesc: "Gitee 直装模式无需登录；登录仅用于提高接口限额（可选）：① 打开 gitee.com → 设置 → 数据管理 → 第三方应用（或直接访问 https://gitee.com/oauth/applications/new）；② 新建应用：应用名称随意，应用主页填 http://127.0.0.1:{port}（任意有效网址即可），应用回调地址填 http://127.0.0.1:{port}/plugin-console/gitee-oauth-callback，权限勾选 user_info、projects；③ 创建成功后把 Client ID / Client Secret 填到下面并点「保存配置」，再点「授权登录 Gitee」",
			giteeClientId: "Client ID",
			giteeClientSecret: "Client Secret",
			giteeSave: "保存配置",
			giteeLoginBtn: "授权登录 Gitee",
			giteeLoggedIn: "已登录 Gitee：",
			giteeClear: "清除登录",
			giteeSetupHint: "未登录（可选）——直装模式无需登录，登录仅提高接口限额",
			giteeLoginPrompt: "Gitee 源不需要登录：直接输入仓库名 owner/repo 搜索安装即可",
			sourcesUpdated: "软件源已更新",
			sourceOf: "源：",
			searchSourceTitle: "点击切换搜索源（GitHub / Gitee / 自定义）",
			recentFailures: "最近安装失败",
			installedAt: "已安装",
			checkUpdate: "检测更新",
			checkingUpdate: "检测中…",
			updateCheckFailed: "检测失败",
			updateAvailable: "发现新版本",
			upToDate: "已是最新版本",
			updateNow: "更新",
			depsOutdatedHint: "本包更新后还需同步以下子包版本（避免版本混搭导致启动冲突）",
			update: "更新版本",
			officialBadge: "官方",
			aggregateBadge: "聚合",
			officialTitle: "官方 dsh plugin add 通道可安装（dsh.bundle 清单）",
			aggregateTitle: "聚合仓库：根包未发布，子包才是插件（查看详情可逐个安装）",
			officialOnlyToggle: "只看官方",
			officialChecking: "正在识别插件类型…",
			elapsed: "已用时",
			skillBadge: "技能",
			skillTitle: "仓库含 SKILL.md，可按技能安装到 ~/.dsh/skills（由 dsh-skill-filesystem 扫描发现）",
			skillTab: "技能",
			pluginsTab: "插件",
			skillMarketEmpty: "技能库为空（自动收录 agent-skills / claude-skills / dsh-skill topic 仓库）",
			installSkill: "装技能",
			skillInstalledTag: "已装",
			skillInstalledMsg: "技能安装完成",
			skillInstallNote: "技能已复制到 ~/.dsh/skills；当前 profile 若未启用 dsh-skill-filesystem 插件，技能不会被发现（启用后重启即可）",
			skillUninstallHint: "删除技能：直接删除 ~/.dsh/skills/<名称> 目录",
			modeBtn: "切换市场模式：插件市场 / 技能市场（技能从 SKILL.md 仓库一键安装到 ~/.dsh/skills）",
			skillsMode: "技能",
			pluginsMode: "插件",
			skillsMarketTitle: "技能市场（GitHub）",
			skillsMarketTitleOther: "技能市场（{source}）",
			skillsSearchPlaceholder: "搜索技能仓库（agent-skills / claude-skills / dsh-skill topic；留空浏览全部）",
			skillsNote: "技能模式仅支持 GitHub 源；技能安装 = 克隆 SKILL.md 仓库到 ~/.dsh/skills/<名称>/，不写补丁、无需重启",
			skillsGithubOnly: "技能搜索仅支持 GitHub 源（其他源请在插件模式使用）",
			installedSkillsTitle: "已安装技能",
			skillDelete: "删除技能",
			skillDeleteConfirm: "确认删除技能「{name}」？",
			skillDeletedMsg: "技能已删除",
			skillsEmpty: "技能库为空（自动收录 agent-skills / claude-skills / dsh-skill topic 仓库）",
			skillsEmptyHint: "这里的「已安装技能」只统计用户技能目录（~/.dsh/skills）；插件自带的技能（如 openviking-memory）随插件在技能中心提供，不在本列表",
			pluginSkillsTitle: "插件自带技能",
			pluginSkillTag: "插件自带",
			pluginSkillsHint: "由已安装插件提供、只读展示；如需在会话中调用，直接使用技能名即可（如 openviking-memory）",
			skillSystemTag: "系统",
			skillSystemTitle: "系统自带技能（~/.dsh/skills/.system 等保留目录），禁止删除",
			skillDisable: "停用",
			skillEnable: "启用",
			skillDisabledTag: "已停用",
			skillDisabledTitle: "已停用：模型与用户命令均不可调用（disable-model-invocation: true，可随时启用）",
			skillToggledMsg: "技能已停用",
			skillEnabledMsg: "技能已启用",
			skillMetaLabel: "技能摘要",
			skillNameLabel: "技能名",
			skillWhenToUseLabel: "适用场景",
			skillRepoNote: "技能仓库（SKILL.md），非 npm 包",
			skillTopicsLabel: "来源",
			skillDetailInstalled: "已装",
			skillDetailDisabled: "已停用",
			skillDetailPath: "安装位置",
			suiteBadge: "套装",
			suiteTitle: "submodule 聚合套装：自动装配子模块组件（bundle 插件 / 普通插件 / 技能 / agent 预设），照仓库 install.ps1 语义执行、不运行第三方脚本",
			suiteInstall: "安装套装",
			suiteInstalledMsg: "套装安装完成",
			suiteComponentType: "组件",
			suiteComponentOk: "成功",
			suiteComponentFail: "失败",
			suiteRepoNote: "套装仓库（submodule 聚合），非 npm 包——安装方式见下方官方命令",
			officialInstallLabel: "官方安装方式",
			copyInstallCmd: "复制",
			copiedInstallCmd: "安装命令已复制，可粘贴到终端手动执行",
			frameworkUpgradeNotice: "检测到 DSH 框架升级：{from} → {to}。已自动备份升级前配置到 {dir}，框架补丁：{patch}；第三方插件请留意兼容性。",
			frameworkPatchApplied: "已重新应用",
			frameworkPatchSkipped: "无需应用",
			frameworkUpgradeBtn: "框架升级",
			frameworkUpgradeTitle: "框架升级：自动打包备份现有配置 → 停止并重启 DSH 服务 → npm 升级框架与配套包（失败自动回滚）→ 拉起服务并适配",
			frameworkUpgradeConfirm: "确认升级？（服务将自动重启）",
			frameworkUpgradeDone: "框架升级流程已执行",
			frameworkRollbackBtn: "回滚到上一版",
			frameworkRollbackTitle: "一键回滚到升级前版本：全树恢复（含依赖世界），脚本自动拉起服务",
			frameworkRollbackDone: "已发起回滚：{from} → 恢复中，服务将短暂断开，请勿手动操作",
			frameworkUpgradeUpToDate: "（已是最新版本）",
			frameworkUpgradeCheckFailed: "（版本检测失败，无法确认是否有更新——请检查网络后重试）",
			frameworkUpToDate: "已是最新框架",
			frameworkUpToDateTitle: "当前 DSH 框架已是最新版本（升级请走官方流程或等新版本发布）",
			frameworkUseUpgrade: "deepseek-harness 是 DSH 框架本体，无需安装；升级请使用卡片上的「框架升级」流程（有新版本时出现）",
			relaunchBtn: "拉起服务",
			relaunchTitle: "框架升级期间服务可能断开——点此手动拉起 DSH 服务（升级脚本也会自动拉起）",
			relaunchDone: "已发起手动拉起（端口无监听时自动启动服务）",
			fwStepBackup: "备份现有配置",
			fwStepStop: "停止服务（页面将断开）",
			fwStepInstall: "升级框架本体",
			fwStepRollback: "升级失败回滚",
			fwStepPkg: "更新官方配套包",
			fwStepRelaunch: "拉起 DSH 服务",
			fwStepDone: "升级完成",
			installBusy: "已有安装/更新任务进行中，请等待完成后再试",
		};
		const en = {
			tab: "Plugin console",
			loading: "Reading plugins…",
			error: "Plugins are temporarily unavailable.",
			retry: "Retry",
			installedTitle: "Installed plugins",
			marketTitle: "Plugin market (GitHub)",
			marketTitleOther: "Plugin market ({source})",
			search: "Search",
			searchPlaceholder: "Search dsh-plugin projects on GitHub (empty = default query)",
			searchPlaceholderOther: "Search {source} for plugins (empty = default query)",
			multiSourceTitle: "Multi-source: GitHub + all custom sources in parallel (Gitee direct mode excluded)",
			multiSourceToggle: "Multi-source search toggle",
			multiEmpty: "No matching plugins found in any search source.",
			giteeRepoPlaceholder: "Enter a Gitee repo (owner/repo, e.g. oschina/git-osc)",
			giteeEmpty: "Gitee's official search API is deprecated: type a repo name (owner/repo, e.g. oschina/git-osc) in the search box and press Enter",
			empty: "No plugins are available.",
			on: "Enable",
			off: "Disable",
			enabledTag: "Enabled",
			disabledTag: "Disabled",
			userDisabledTag: "Disabled by patch",
			pendingCompatTag: "Pending adapt",
			pendingCompatHint: "Force-disabled after framework upgrade: click Check update first; if a newer version exists the button becomes Update & adapt - click it and it unlocks automatically after the compat check",
			updateAndAdapt: "Update & adapt",
			familyTag: "Family bundle",
			familySubs: "sub packages",
			familyUnlockAll: "Unlock all adapted",
			familyUnlockAllTip: "Re-run the source scan for sub packages not yet verified: passing ones get unlocked; failing ones stay disabled with a reason",
			familyUnlockAllConfirm: "Re-run the source scan for every not-yet-verified sub package in this family and unlock the ones that pass? Failing ones stay disabled.",
			familyUnlockAllDone: "Family batch unlock done",
			familyExpand: "Expand",
			familyCollapse: "Collapse",
			familyUpdate: "Family version check",
			familyCheckUpdate: "Check all",
			familyUpdateBtn: "Update",
			familyCheckUpdateTip: "When a newer version is detected this Update button appears; click to start the full-family update (subpackage alignment + adapt check)",
			adaptUnlockBtn: "Adapted - unlock now",
			adaptUnlockHint: "Installed version passed the source scan for the current framework: unlock immediately",
			adaptUnlockDone: "Unlocked: refresh and the row is enabled",
			riskyEnableTitle: "Force-enable an incompatible plugin?",
			riskyEnableBody: "This plugin is judged incompatible with the current framework (auto-disabled during the upgrade). Force-enabling it may make the next DSH start fail and require manual recovery. Force-enable?",
			riskyEnableConfirm: "Force enable",
			riskyEnableCancel: "Cancel",
			adoptableDetected: "Now compatible: version {version} passed the source scan — click \"Adapted - unlock now\" to enable it (never auto-enabled)",
			compatGateLabel: "Compat gate",
			compatGateAutoDisable: "Auto-disable incompatible plugins on upgrade",
			compatGateAutoDetect: "Detect adapted plugins on open (hint only)",
			compatGateHint: "Turn off to go fully manual: the upgrade only warns and never touches your switches, and no detection hints are shown",
			compatGateSaved: "Compat gate settings saved",
			gateBtn: "Gating",
			gateTitle: "Gating: auto-disable incompatible plugins on upgrade, detect adapted ones on open",
			gateModalTitle: "Gating (compat gate master switches)",
			gatePendingInfo: "Pending adaptation: {n} row(s) — recorded by the upgrade pre-scan or boot quarantine; unlock them after updating the plugin",
			gatePendingNone: "No rows pending adaptation",
			fwFailedButUpgraded: "The framework itself is already on {v} and active — only the final \"restart service\" step failed. Use Restart service to confirm, or roll back if needed.",
			fwPanelBtn: "Framework",
			fwPanelTitle: "Framework upgrade / rollback",
			fwPanelCurrent: "Installed",
			fwPanelAvailable: "Upgrade available: {v}",
			fwPanelUpToDate: "Up to date (latest {latest} · next {next})",
			fwPanelCheckFailed: "Version check failed: {err}",
			fwPanelChecking: "checking…",
			fwPanelRecheck: "Re-check version",
			fwPanelRefreshStatus: "Refresh progress",
			fwPanelNoRecord: "No upgrade record yet (the last upgrade/rollback steps will always be shown here)",
			fwPanelConfirmBody: "Upgrade to {v}? The script will back up config, pre-disable incompatible rows, stop the service, install the new version and relaunch it; if it fails to start it quarantines and retries first, and only then rolls back the whole tree.",
			fwRollbackDone: "Already rolled back to {v} (this is the snapshot version; nothing earlier to restore)",
			migrateTip: "Project migrated (adapted to the current framework)",
			migrateBtn: "Migrate & adapt",
			aiEmpowerFrameworkCheck: "Framework compat check",
			userForcedTag: "Forced on by patch",
			protectedTag: "Protected",
			unobserved: "Not mounted",
			pending: "Waiting for dependencies",
			loadingPhase: "Loading",
			active: "Mounted",
			failed: "Mount failed",
			unloading: "Unloading",
			toggledOn: "Enable requested",
			toggledOff: "Disable requested",
			failed: "Operation failed",
			view: "Inspect",
			install: "Add & enable",
			installing: "Installing…",
			marketLoading: "Searching GitHub…",
			marketLoadingOther: "Searching {source}…",
			directOther: "Searching {source} through the server channel (custom sources do not use browser-direct)",
			marketError: "Search failed",
			marketEmpty: "No matching projects.",
			repoLoading: "Reading repository…",
			repoError: "Failed to read repository",
			packageName: "npm package",
			dshHint: "Looks like a DSH plugin",
			noPackage: "This repository has no package.json, cannot install",
			privateRootHint: "Root package is not published to npm (private); cannot install directly",
			subpackagesTitle: "Repository subpackages (installable individually)",
			subpackagesLoading: "Reading subpackage list…",
			subpackagesError: "Failed to read subpackages (retry later if the network is flaky)",
			subpackagesEmpty: "No installable subpackages found.",
			recentFailures: "Recent install failures",
			installed: "Installed and enabled",
			installNote: "HMR is applying; refresh the page if the plugin ships UI",
			bundleNote: "This package is a bundle-layer plugin (e.g. skin packs); restart the DSH service to activate it",
			direct: "(The browser calls GitHub directly; the server channel is used as fallback.)",
			details: "Details",
					expandDesc: "Expand",
			collapseDesc: "Collapse",
			addLocal: "Add locally",
			installingLocal: "Installing…",
			needPackage: "This repository has no package.json, cannot add directly",
			noDetail: "No description provided for this plugin.",
			versionLabel: "Version",
			repoLabel: "Repository",
			homepageLabel: "Homepage",
			readmeLabel: "Readme summary",
			loadingDetails: "Reading details…",
			githubLoggedIn: "GitHub signed in: ",
                    hubUpdateAvailable: "Download update",
                    cleanResiduals: "Clean residual backups",
			githubCornerOut: "Not signed in to GitHub",
			githubLoginViaApp: "GitHub login",
			githubLoginOpened: "Authorization window opened — enter the code on the GitHub page to finish",
			githubLoginUnavailable: "Window login unavailable",
			githubLoginOrToken: "Or sign in with a token",
			githubLoginTip: "Paste a GitHub token to sign in (fine-grained, needs the read:user scope). Signing in enables code search (search by subpackage name) and raises API rate limits; you can also sign in with the dsh-github-login plugin.",
			githubTokenPlaceholder: "Paste token (ghp_… or github_pat_…)",
			githubLoginBtn: "Sign in",
			githubLoginOk: "Signed in to GitHub: {login}",
			githubLoginFail: "Sign-in failed",
					searchInstalledPlaceholder: "Search installed plugins (name or id)",
			extraFilter: "Installed",
			extraFilterAll: "All",
			extraTag: "Third-party",
			extraFilterTitle: "Toggle: installed (extra/third-party) / all",
			extraEmpty: "No installed extra (non-bundled) plugins.",
			noMatch: "No matching plugins.",
			loadMore: "Load more",
			loadingMore: "Loading…",
			backToSearch: "Back to search",
			collapseResults: "Collapse results",
			expandResults: "Expand results",
			reloadPage: "Reload page",
			refreshList: "Refresh plugin list",
			stageLabel: "Stage",
			stagePreparing: "Preparing",
			stageInstalling: "Downloading & installing (safe to leave this page)",
			stageConfiguring: "Writing enable config",
			stageRepairing: "Local AI is taking over the install…",
			restartService: "Restart service",
			restarting: "Service restarting, the page will recover shortly…",
			autoReload: "Page will auto-reload…",
			aiRepaired: "Local AI took over and finished the repair; refresh the page",
			deletePlugin: "Delete plugin (remove config and uninstall package)",
			confirmDelete: "Confirm delete?",
			deleting: "Deleting…",
			deleteNote: "Plugin deleted and package uninstalled; refreshing",
			deleteBundleNote: "Owning bundle removed; takes effect after service restart",
			pendingRestartTag: "Installed · after restart",
			pendingRestartHint: "The package is installed and will show up in the list above after a restart; deleting now revokes this install",
			pendingRestartDelete: "Revoke this install (drop patch row, bundles entry and package dir)",
			pendingRestartNote: "Install revoked (patch row, bundles entry and package dir cleaned)",
			pendingRestartPartial: "Revoke incomplete — handle the leftovers manually as reported",
			aiConsentText: "All regular install channels failed. Next, the local AI takes over the install, which calls a DeepSeek API model and may incur API costs. Continue?",
			aiConsentNotifyTitle: "Plugin install needs approval",
			aiConsentApprove: "Agree, continue (may incur costs)",
			aiConsentDecline: "Cancel",
			aiConsentCardTitle: "⚠ Approval needed: local AI fallback",
			aiConsentCountdown: "Time left",
			aiConsentTimeoutNote: "No choice within {min} minutes cancels it automatically (no cost at all)",
			aiConsentLastError: "Last error from the deterministic channels",
			aiConsentTopHint: "⚠ An install is waiting for your approval: every deterministic channel failed, and the local AI fallback (which calls the model API and may incur costs) needs your consent — choose Agree / Cancel in the install progress area",
			progressSubpackage: "Installing subpackage {index}/{total}: {name}",
			progressSuiteClone: "Cloning submodule {index}/{total}: {name}",
			progressSuiteAssemble: "Assembling submodule {index}/{total}: {name}",
			progressDone: "Completed ({total} total)",
			aiFallbackLabel: "AI fallback",
			aiEmpowerLabel: "AI Empower",
			aiEmpowerTitle: "AI Empower: read docs, plan and deploy a component automatically; server-type components get start/stop buttons",
			aiEmpowerSrcTitle: "Component to deploy (npm package or GitHub repo)",
			aiEmpowerPlanTitle: "AI Empower deployment plan",
			aiEmpowerType: "Type",
			aiEmpowerTypeMapping: { "pure-plugin": "Pure plugin", "service": "Server component", "config-only": "Config only" },
			aiEmpowerSteps: "Steps to execute (selectable)",
			aiEmpowerRun: "Approve & deploy",
			aiEmpowerNeedSteps: "Select at least one step; then click Approve & deploy to execute",
			aiConfirmDeploy: "About to run {n} deployment step(s) for {name} (may install software / write config / start services). Approve and deploy?",
			aiPlanHint: "⚠️ AI only drafts the plan — deployment needs your explicit consent: select steps → Approve & deploy → (second confirmation)",
			aiWorkspaceInfo: "Research workspace",
			aiEmpowerCancel: "Cancel",
			aiEmpowerWaiting: "AI is analyzing the docs and drafting the plan (1-5 min, calls DeepSeek API, may incur costs)…",
			aiEmpowerExecuting: "AI Empower executing…",
			aiEmpowerDone: "AI Empower deployment finished",
			aiEmpowerFail: "AI Empower failed",
			aiEmpowerLogs: "Execution log",
			aiEmpowerComponents: "Detected server components",
			compStart: "Start",
			compStop: "Stop",
			compStatus: "Status",
			compOpen: "Open",
			compRunning: "Running",
			compStopped: "Stopped",
			compHealthy: "Healthy",
			compUnhealthy: "Unhealthy",
			compRefresh: "Refresh component status",
			compDropTitle: "Expand to open all server URLs",
			compNoUrl: "No URL yet",
			compCollapseTitle: "Collapse server card",
			compExpandTitle: "Expand server card",
			toolbarLabel: "Feature pack",
			toolbarOpenTitle: "Expand feature pack",
			toolbarCloseTitle: "Collapse feature pack",
			repoLandLabel: "Repo land",
			repoLandTitle: "Repo land: clone any project to ~/.dsh/repos/ via git source \"{source}\" (not limited to DSH plugins)",
			repoLandSourceUnknown: "the configured git source",
			repoLandPlaceholder: "owner/repo or repo URL, e.g. deepseek-ai/deepseek-harness",
			repoLandBusy: "Cloning… (large repos may take a while)",
			repoLandDone: "Landed at: ",
			repoLandOpenFolder: "Open folder",
			repoLandExists: "Already exists — nothing to clone",
			repoLandDirLabel: "Save path",
			repoLandSaveDir: "Save path",
			repoLandList: "Landed repos",
			repoLandRemoveConfirm: "Delete landed repo {repo} (local folder will be removed)?",
			repoLandEntry: "Repo land",
			repoLandLanded: "Landed",
			aiProgressTitle: "AI Empower in progress — click to view",
			compAutoTitle: "Autostart: launch this server automatically when DSH starts (off = manual)",
			compActionDone: "{action}: {name}",
			noComponents: "No server components yet (they appear after an AI Empower deployment)",
			aiFallbackTitle: "When off: if regular channels fail, the install is cancelled directly without calling the model API (zero cost)",
			aiFallbackOff: "AI fallback is disabled by your setting; this install was cancelled (zero cost)",
			aiConsentRemember: "Don't ask again (auto-approve the AI fallback, may incur costs; restore reminders anytime at the very bottom of the market)",
			aiRememberNote: "AI fallback auto-approved per your setting (restore reminders at the market bottom)",
			aiRememberReset: "AI fallback reminders disabled (click to restore)",
			consentWaiting: "Awaiting approval…",
			dismissFailure: "Dismiss this notice",
			sourcesBtn: "Sources",
			sourcesTitle: "Software sources",
			sourcesDesc: "Roles: ① registry = download npm packages (install); ② index sources = market list JSON; ③ git sources = clone repo code (when no npm package); ④ search sources = where to search — results are still downloaded via ①/③",
			sourcePrimary: "Primary",
			setPrimary: "Set primary",
			registryScan: "Scan sources",
			registryScanHint: "Probe each npm registry: reachability, latency, and the latest dsh-plugin-console version it serves (to pick the best primary)",
			registryScanning: "Scanning…",
			registryScanSummary: "Scan complete: {ok}/{total} reachable",
			registryScanBest: "Newest {version} comes from: {name}",
			registryScanNoVersion: "Package not on this registry",
			registryScanFail: "unreachable",
			setPrimaryHint: "Set primary: tried first, falls back to the others on failure",
			editSourceHint: "Edit: change this source's name and URL",
			removeSourceHint: "Remove: delete this source from the list (installed plugins unaffected)",
			removeSource: "Remove",
			sourceName: "Name",
			sourceUrl: "URL (https://…)",
			addSource: "Add",
			resetSources: "Reset defaults",
			closeModal: "Close",
			invalidSourceUrl: "Source URL must start with https:// (or a private http:// address)",
			editSource: "Edit",
			saveSource: "Save",
			cancelEdit: "Cancel",
			searchSourcesTitle: "Search sources",
			searchSourcesDesc: "Search platforms (switch via the pill). Custom sources use a URL template: {q}=keyword, {page}=page number",
			addSearchSource: "Add search source",
			indexSourcesTitle: "Index sources",
			indexSourcesDesc: "Download URLs for the static market index (primary first, others retried in order). Point this at an intranet service — note the index CONTENT comes from that JSON, so host a merged public+private index there. To see both sides at once, turn on \"Merge all index sources\" below",
			indexMergeLabel: "Merge all index sources",
			indexMergeDesc: "On: results from all index sources are merged and de-duplicated (public index + company intranet private index visible together). Off: only one source is used, primary first (intranet-friendly, faster)",
			addIndexSource: "Add index source",
			indexUrlPlaceholder: "Index JSON URL (https:// or local/intranet http://)",
			gitSourcesTitle: "Git sources",
			gitSourcesDesc: "URL template for cloning ({owner}/{repo} placeholders). This list IS the custom git-source list — the two built-ins are just defaults; click Add git source to swap in your own: Gitee = https://gitee.com/{owner}/{repo}.git; GitLab = https://gitlab.com/{owner}/{repo}.git; self-hosted Gitea = https://your-domain/{owner}/{repo}.git; mirror proxy = https://mirror/https://github.com/{owner}/{repo}.git; local bare repo = file:///D:/repos/{owner}/{repo}.git. Primary first, falls back on failure",
			addGitSource: "Add Git source",
			gitUrlPlaceholder: "e.g. https://gitee.com/{owner}/{repo}.git",
			gitSourceBtn: "Git sources",
			marketIndexOffline: "Offline data · cached {time} (index sources unreachable, showing last successful result)",
			marketIndexStale: "Market index not loaded: search only covers live GitHub results (name/description/topics); curated entries and local fuzzy matching are unavailable",
			marketIndexRetry: "Retry loading index",
			searchLoginHint: "GitHub not signed in: code search is unavailable (searching by subpackage name needs sign-in); repository search still works",
			marketIndexFrom: "Index source: {source}",
			marketIndexFailed: "Failed to load market index",
			unknown: "unknown",
			searchUrlPlaceholder: "URL template (must contain {q})",
			invalidSearchUrl: "Search URL template must contain the {q} placeholder",
			headersPlaceholder: "Headers (optional): one per line, format Name: Value, e.g. Authorization: Bearer token",
			giteeTitle: "Gitee login (optional)",
			giteeDesc: "Gitee direct-repo mode needs no login; login only raises API rate limits (optional): ① Open gitee.com → Settings → Data management → Third-party apps (or go directly to https://gitee.com/oauth/applications/new); ② Create an app: any app name, homepage URL = http://127.0.0.1:{port} (any valid URL works), redirect/callback URL = http://127.0.0.1:{port}/plugin-console/gitee-oauth-callback, grant scope user_info, projects; ③ Fill Client ID / Client Secret below, click Save, then click Authorize Gitee",
			giteeClientId: "Client ID",
			giteeClientSecret: "Client Secret",
			giteeSave: "Save",
			giteeLoginBtn: "Authorize Gitee",
			giteeLoggedIn: "Signed in to Gitee: ",
			giteeClear: "Clear login",
			giteeSetupHint: "Not signed in (optional) — direct mode needs no login; login raises rate limits",
			giteeLoginPrompt: "Gitee login is optional: type a repo name owner/repo to search and install",
			sourcesUpdated: "Sources updated",
			sourceOf: "Source: ",
			searchSourceTitle: "Click to switch search source (GitHub / Gitee / custom)",
			recentFailures: "Recent install failures",
			installedAt: "Installed",
			checkUpdate: "Check update",
			checkingUpdate: "Checking…",
			updateCheckFailed: "Check failed",
			updateAvailable: "New version available",
			upToDate: "Up to date",
			updateNow: "Update",
			depsOutdatedHint: "Updating this package also needs these subpackage versions (avoid mixed-version startup conflicts)",
			update: "Update",
			officialBadge: "Official",
			aggregateBadge: "Aggregate",
			officialTitle: "Installable via official dsh plugin add (dsh.bundle manifest)",
			aggregateTitle: "Aggregate repo: root unpublished; subpackages are the plugins (view to install)",
			officialOnlyToggle: "Official only",
			officialChecking: "Identifying plugin types…",
			elapsed: "Elapsed",
			skillBadge: "Skill",
			skillTitle: "Repo contains SKILL.md — installable as a skill into ~/.dsh/skills (scanned by dsh-skill-filesystem)",
			skillTab: "Skills",
			pluginsTab: "Plugins",
			skillMarketEmpty: "Skill library is empty (auto-collected from agent-skills / claude-skills / dsh-skill topic repos)",
			installSkill: "Install skill",
			skillInstalledTag: "Installed",
			skillInstalledMsg: "Skill installed",
			skillInstallNote: "Skill copied to ~/.dsh/skills; if the current profile does not enable the dsh-skill-filesystem plugin the skill won't be discovered (enable it and restart)",
			skillUninstallHint: "To remove a skill: delete the ~/.dsh/skills/<name> directory",
			modeBtn: "Switch market mode: plugin market / skill market (skills install from SKILL.md repos into ~/.dsh/skills)",
			skillsMode: "Skills",
			pluginsMode: "Plugins",
			skillsMarketTitle: "Skill market (GitHub)",
			skillsMarketTitleOther: "Skill market ({source})",
			skillsSearchPlaceholder: "Search skill repos (agent-skills / claude-skills / dsh-skill topics; empty = browse all)",
			skillsNote: "Skill mode supports the GitHub source only; installing a skill = clone the SKILL.md repo into ~/.dsh/skills/<name>/, no patch, no restart",
			skillsGithubOnly: "Skill search supports the GitHub source only (use plugin mode for other sources)",
			installedSkillsTitle: "Installed skills",
			skillDelete: "Remove skill",
			skillDeleteConfirm: "Remove skill「{name}」?",
			skillDeletedMsg: "Skill removed",
			skillsEmpty: "Skill library is empty (auto-collected from agent-skills / claude-skills / dsh-skill topic repos)",
			skillsEmptyHint: "This list only counts user skills (~/.dsh/skills); plugin-provided skills (e.g. openviking-memory) appear in the Skill Center, not here",
			pluginSkillsTitle: "Plugin-provided skills",
			pluginSkillTag: "Plugin",
			pluginSkillsHint: "Provided by installed plugins, read-only; invoke by skill name (e.g. openviking-memory)",
			skillSystemTag: "System",
			skillSystemTitle: "System-owned skill (~/.dsh/skills/.system etc.), cannot be removed",
			skillDisable: "Disable",
			skillEnable: "Enable",
			skillDisabledTag: "Disabled",
			skillDisabledTitle: "Disabled: neither model nor user commands can invoke it (disable-model-invocation: true, re-enable anytime)",
			skillToggledMsg: "Skill disabled",
			skillEnabledMsg: "Skill enabled",
			skillMetaLabel: "Skill summary",
			skillNameLabel: "Skill name",
			skillWhenToUseLabel: "When to use",
			skillRepoNote: "Skill repo (SKILL.md), not an npm package",
			skillTopicsLabel: "Source",
			skillDetailInstalled: "Installed",
			skillDetailDisabled: "Disabled",
			skillDetailPath: "Location",
			suiteBadge: "Suite",
			suiteTitle: "Submodule aggregate suite: auto-assembles components (bundle plugins / plugins / skills / agent presets) following the repo's install.ps1 semantics without executing third-party scripts",
			suiteInstall: "Install suite",
			suiteInstalledMsg: "Suite installed",
			suiteComponentType: "Component",
			suiteComponentOk: "OK",
			suiteComponentFail: "Failed",
			suiteRepoNote: "Suite repo (submodule aggregate), not an npm package — see the official install command below",
			officialInstallLabel: "Official install",
			copyInstallCmd: "Copy",
			copiedInstallCmd: "Install command copied — paste into your terminal to run it manually",
			frameworkUpgradeNotice: "DSH framework upgrade detected: {from} → {to}. Pre-upgrade config backed up to {dir}; framework patch: {patch}. Check third-party plugin compatibility.",
			frameworkPatchApplied: "reapplied",
			frameworkPatchSkipped: "not needed",
			frameworkUpgradeBtn: "Framework upgrade",
			frameworkUpgradeTitle: "Framework upgrade: backup config → stop & restart DSH service → npm upgrade framework + official packages (auto rollback on failure) → relaunch and adapt",
			frameworkUpgradeConfirm: "Confirm upgrade? (service will restart)",
			frameworkUpgradeDone: "Framework upgrade flow executed",
			frameworkUpgradeUpToDate: " (already latest)",
			frameworkUpgradeCheckFailed: " (version check failed - cannot confirm update, check network and retry)",
			frameworkUpToDate: "Framework up to date",
			frameworkUpToDateTitle: "Current DSH framework is already the latest (upgrade via the official flow or wait for a new release)",
			frameworkUseUpgrade: "deepseek-harness is the DSH framework itself, not a plugin; upgrade via the card's Framework Upgrade flow (shown when a new version exists)",
			relaunchBtn: "Relaunch service",
			frameworkRollbackBtn: "Rollback to previous",
			frameworkRollbackTitle: "One-click rollback to the previous framework version (full tree), service relaunches automatically",
			frameworkRollbackDone: "Rollback started: {from} -> restoring, service will briefly disconnect",
			relaunchTitle: "During a framework upgrade the service may disconnect — click to manually relaunch the DSH service (the upgrade script also relaunches automatically)",
			relaunchDone: "Manual relaunch requested (starts the service if the port is not listening)",
			fwStepBackup: "Backup current config",
			fwStepStop: "Stop service (page will disconnect)",
			fwStepInstall: "Upgrade framework",
			fwStepRollback: "Rollback on failure",
			fwStepPkg: "Update official packages",
			fwStepRelaunch: "Relaunch DSH service",
			fwStepDone: "Upgrade complete",
		};
		//#endregion
		const NS = "settings.pluginConsole";
		const inject = ["slots", "locale"];
		const PHASE_KEYS = { pending: "pending", loading: "loadingPhase", active: "active", failed: "failed", unloading: "unloading" };
		const GITHUB_API = "https://api.github.com";
		const GITHUB_RAW = "https://raw.githubusercontent.com";
		const el = react.createElement;
		function moduleShortName(moduleName) {
			return (moduleName.startsWith("@") ? moduleName.slice(moduleName.indexOf("/") + 1) : moduleName)
				.replace(/^cordis:/, "").replace(/^cordis-plugin-/, "").replace(/^dsh-(?:host-|client-)?/, "");
		}
		/** 提取 README 标题与开篇摘要（与宿主端 summarizeReadme 同规则）。 */
		function summarizeReadmeText(text) {
			const lines = text.split(/\r?\n/u);
			let title = "";
			const intro = [];
			for (const line of lines) {
				const heading = line.match(/^(#{1,3})\s+(.+)$/u);
				if (heading) {
					if (title === "") { title = heading[2].trim(); continue; }
					break;
				}
				if (title === "") continue;
				const cleaned = line.replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
					.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
					.replace(/[`*_~]/gu, "")
					.trim();
				if (cleaned) intro.push(cleaned);
				if (intro.join(" ").length > 700) break;
			}
			return { title, summary: intro.join(" ").trim().slice(0, 900) };
		}
		function phaseLabel(phase, t) {
			return phase === null ? t("unobserved") : t(PHASE_KEYS[phase]);
		}
		async function call(path, body) {
			const response = await fetch(path, body === undefined
				? {}
				: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			let data = null;
			try {
				data = await response.json();
			} catch {}
			if (!response.ok || (data !== null && data.ok === false)) {
				const error = new Error(data !== null && typeof data.error === "string" ? data.error : "HTTP " + response.status);
				// 结构化错误码随错误对象带回（如适配门软禁的 compat-confirm → 前端要弹风险确认）
				if (data !== null && data.details !== undefined) error.details = data.details;
				throw error;
			}
			return data;
		}
		/** 超时类错误附上可操作提示（网络黑洞期的最常见表现）。 */
		function friendlyGithubError(error) {
			const msg = error !== null && typeof error.message === "string" ? error.message : String(error);
			if (/超时|timeout|aborted|网络/iu.test(msg)) {
				return new Error(msg + "（当前网络可能处于波动期：稍等一两分钟再试；或刷新页面，让浏览器直连通道重新工作）");
			}
			return error;
		}
		async function githubFetch(url) {
			const response = await fetch(url, {
				headers: { accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(15000),
			});
			if (response.status === 403) throw new Error("GitHub 匿名接口限流已用尽，请稍后再试");
			if (!response.ok) throw new Error("GitHub 请求失败 (HTTP " + response.status + ")");
			return response.json();
		}
		/** 对路径中的每一段做百分号编码，保留 "/" 作为分隔符，防止特殊字符篡改目标 URL。 */
		const encodePathSegments = (value) => String(value).split("/").map(encodeURIComponent).join("/");
		/** raw 文件多通道竞速：官方直连 + 常见 gh 镜像，谁先成功用谁；非 GitHub 平台走对应 raw 地址。 */
		const RAW_CANDIDATES = [
			(repo, branch, file) => `${GITHUB_RAW}/${repo}/${branch}/${file}`,
			(repo, branch, file) => `https://ghproxy.net/https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
			(repo, branch, file) => `https://ghfast.top/https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
			(repo, branch, file) => `https://mirror.ghproxy.com/https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
		];
		async function fetchRawText(repo, branch, file, source = "github") {
			repo = encodePathSegments(repo);
			branch = encodePathSegments(branch);
			file = encodePathSegments(file);
			if (source === "gitee") {
				try {
					const res = await fetch(`https://gitee.com/${repo}/raw/${branch}/${file}`, { signal: AbortSignal.timeout(15000) });
					if (!res.ok) return null;
					return await res.text();
				} catch { return null; }
			}
			const attempts = RAW_CANDIDATES.map((build) => fetch(build(repo, branch, file), {
				signal: AbortSignal.timeout(15000),
			}).then((res) => {
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.text();
			}));
			try {
				return await Promise.any(attempts);
			} catch {
				return null;
			}
		}
		/** 浏览器直连 GitHub 搜索；失败抛错由调用方回退到服务端通道。 */
		async function searchFromGithub(q, page, all) {
			const base = (q ?? "").trim() || "dsh-plugin";
			const query = all ? base : (base + " topic:dsh-plugin");
			const data = await githubFetch(`${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=20&page=${Math.max(page || 1, 1)}`);
			return (data.items ?? []).map((item) => ({
				fullName: item.full_name,
				description: item.description ?? "",
				htmlUrl: item.html_url,
				stars: item.stargazers_count ?? 0,
				updatedAt: item.updated_at ?? "",
				defaultBranch: item.default_branch ?? "main",
				topics: item.topics ?? [],
			}));
		}
		/** 提取 SKILL.md frontmatter 摘要（name / description / whenToUse，与宿主端同规则）。 */
		function summarizeSkillFrontmatter(text) {
			const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
			if (fm === "") return null;
			const KEY_PATTERNS = {
				name: /^name:\s*(.*)$/mu,
				description: /^description:\s*(.*)$/mu,
				whenToUse: /^whenToUse:\s*(.*)$/mu,
			};
			const pick = (key) => {
				const m = fm.match(KEY_PATTERNS[key]);
				if (!m) return "";
				const first = m[1].trim();
				if (first.startsWith("|")) {
					// 多行块：取后续行直到下一个键或结束
					const rest = fm.slice(m.index + m[0].length);
					const lines = [];
					for (const line of rest.split("\n")) {
						if (/^[a-zA-Z][\w-]*\s*:/u.test(line)) break;
						const v = line.trim();
						if (v) lines.push(v);
						if (lines.join(" ").length > 240) break;
					}
					return lines.join(" ").slice(0, 500);
				}
				return first.slice(0, 200);
			};
			const name = pick("name");
			const description = pick("description");
			const whenToUse = pick("whenToUse");
			if (!name && !description && !whenToUse) return null;
			return { name, description, whenToUse };
		}
		/** 浏览器直连读取仓库元数据 + package.json + README 摘要。
		 * 搜索结果自带描述/star/分支信息，seed 存在时跳过 api.github.com 请求
		 * （该接口在黑洞期会挂起很久，是"查看没反应"的根因）。 */
		async function repoInfoFromGithub(repo, seed) {
			let branch = "main";
			let metaDescription = "";
			let metaStars = 0;
			if (seed && typeof seed.defaultBranch === "string" && seed.defaultBranch) {
				branch = seed.defaultBranch;
				metaDescription = seed.description ?? "";
				metaStars = seed.stars ?? 0;
			} else {
				const meta = await githubFetch(`${GITHUB_API}/repos/${encodeURIComponent(repo)}`);
				branch = meta.default_branch ?? "main";
				metaDescription = meta.description ?? "";
				metaStars = meta.stargazers_count ?? 0;
			}
			let pkg = null;
			let readme = null;
			let skill = null;
			const pkgText = await fetchRawText(repo, branch, "package.json");
			if (pkgText !== null) {
				try { pkg = JSON.parse(pkgText); } catch {}
			}
			const readmeText = await fetchRawText(repo, branch, "README.md");
			if (readmeText !== null) readme = summarizeReadmeText(readmeText);
			const skillText = await fetchRawText(repo, branch, "SKILL.md");
			if (skillText !== null) skill = summarizeSkillFrontmatter(skillText);
			return {
				repo,
				defaultBranch: branch,
				description: metaDescription,
				stars: metaStars,
				packageName: pkg !== null && typeof pkg.name === "string" ? pkg.name : null,
				packageDescription: pkg !== null && typeof pkg.description === "string" ? pkg.description : null,
				hasPackageJson: pkg !== null,
				privateRoot: pkg !== null && pkg.private === true,
				readme,
				skill,
				dshHint: pkg !== null && (
					typeof pkg.name === "string" && /(^|-)dsh[-/]/u.test(pkg.name)
					|| pkg.peerDependencies !== undefined && pkg.peerDependencies["@deepseek-ai/cordis"] !== undefined
					|| Array.isArray(pkg.keywords) && pkg.keywords.includes("dsh-plugin")
				),
			};
		}
		/** 只取仓库的 npm 包名与 private 标记（跳过 README 与 api.github.com，供"添加到本地"快捷路径使用）。 */
		async function fetchPackageName(repo, seedBranch, source = "github") {
			const branch = typeof seedBranch === "string" && seedBranch ? seedBranch : "main";
			const pkgText = await fetchRawText(repo, branch, "package.json", source);
			if (pkgText !== null) {
				try {
					const pkg = JSON.parse(pkgText);
					if (pkg && typeof pkg.name === "string") return { name: pkg.name, private: pkg.private === true };
				} catch {}
			}
			return null;
		}
		/** 非 GitHub 平台仓库详情：seed 自带元数据，直接用平台 raw 读 package.json 与 README。 */
		async function repoInfoFromPlatform(item) {
			const source = item.source ?? "github";
			const branch = item.defaultBranch ?? (source === "gitee" ? "master" : "main");
			let pkg = null;
			let readme = null;
			let skill = null;
			const pkgText = await fetchRawText(item.fullName, branch, "package.json", source);
			if (pkgText !== null) {
				try { pkg = JSON.parse(pkgText); } catch {}
			}
			const readmeText = await fetchRawText(item.fullName, branch, "README.md", source);
			if (readmeText !== null) readme = summarizeReadmeText(readmeText);
			const skillText = await fetchRawText(item.fullName, branch, "SKILL.md", source);
			if (skillText !== null) skill = summarizeSkillFrontmatter(skillText);
			return {
				repo: item.fullName,
				defaultBranch: branch,
				description: item.description ?? "",
				stars: item.stars ?? 0,
				packageName: pkg !== null && typeof pkg.name === "string" ? pkg.name : null,
				packageDescription: pkg !== null && typeof pkg.description === "string" ? pkg.description : null,
				hasPackageJson: pkg !== null,
				privateRoot: pkg !== null && pkg.private === true,
				readme,
				skill,
				dshHint: pkg !== null && (
					typeof pkg.name === "string" && /(^|-)dsh[-/]/u.test(pkg.name)
					|| pkg.peerDependencies !== undefined && pkg.peerDependencies["@deepseek-ai/cordis"] !== undefined
					|| Array.isArray(pkg.keywords) && pkg.keywords.includes("dsh-plugin")
				),
			};
		}
		/** monorepo 子包列表：git trees 递归列出 packages 目录下的 package.json，逐个取 npm 包名（上限 24 个）。 */
		async function fetchSubpackages(repo, branch) {
			const data = await githubFetch(`https://api.github.com/repos/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
			const paths = (data.tree ?? []).filter((node) => node.type === "blob" && /^(?:packages|examples|plugins|skills|apps|extensions|src|lib)\/[^/]+\/package\.json$/u.test(node.path)).map((node) => node.path);
			if (paths.length === 0) return [];
			const out = [];
			for (const path of paths.slice(0, 24)) {
				const text = await fetchRawText(repo, branch, path);
				if (text === null) continue;
				try {
					const pkg = JSON.parse(text);
					if (pkg && typeof pkg.name === "string") out.push({ dir: path.split("/")[1], path: path.split("/").slice(0, -1).join("/"), name: pkg.name });
				} catch {}
			}
			return out;
		}
		/** 批量识别搜索结果：官方通道（根包 dsh.bundle）/ 聚合仓库（private+workspaces，子包才是插件）/ 普通项目。 */
		/** 补标「官方 / 聚合」标记。每条要发网络请求（raw 多通道竞速），
		 * 因此限制并发（默认 6 条一批），避免打满浏览器连接数拖慢整页。 */
		async function enrichOfficialBundle(items, concurrency = 6) {
			const out = [];
			for (let i = 0; i < items.length; i += concurrency) {
				const batch = items.slice(i, i + concurrency);
				const done = await Promise.all(batch.map(async (item) => {
					let official = null;
					let aggregate = false;
					const pkgText = await fetchRawText(item.fullName, item.defaultBranch, "package.json", item.source ?? "github");
					if (pkgText !== null) {
						try {
							const pkg = JSON.parse(pkgText);
							if (typeof pkg.dsh?.bundle?.patch === "string") {
								official = true;
							} else if (pkg.private === true && (Array.isArray(pkg.workspaces) || /(^|-)dsh[-/]/u.test(String(pkg.name ?? "")))) {
								aggregate = true;
							}
						} catch {}
					}
					return { ...item, official, aggregate };
				}));
				out.push(...done);
			}
			return out;
		}
		/** 源地址校验（与宿主端一致）：https 任意；http 仅限本机/私网（内网源常用 http）。 */
		function isAllowedSourceUrl(url) {
			if (/^https:\/\/\S+$/u.test(url)) return true;
			if (!/^http:\/\/\S+$/u.test(url)) return false;
			try {
				const host = new URL(url).hostname.toLowerCase();
				if (host === "localhost" || host === "::1" || host === "[::1]") return true;
				if (/^127\.\d+\.\d+\.\d+$/u.test(host)) return true;
				if (/^10\.\d+\.\d+\.\d+$/u.test(host)) return true;
				if (/^192\.168\.\d+\.\d+$/u.test(host)) return true;
				if (/^169\.254\.\d+\.\d+$/u.test(host)) return true;
				const m = host.match(/^172\.(\d+)\.\d+\.\d+$/u);
				if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
				if (/^[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7}$/iu.test(host)) return true;
				return false;
			} catch {
				return false;
			}
		}
		function PluginConsoleTab({ t }) {
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(null);
			const [adaptUnlocking, setAdaptUnlocking] = react.useState(null);
			// 待适配行「强行启用」的风险确认态：{ entryId, moduleName, frameworkVersion, checkNote } | null
			const [riskyConfirm, setRiskyConfirm] = react.useState(null);
			const [message, setMessage] = react.useState(null);
			const [reloadHint, setReloadHint] = react.useState(false);
			const [restartHint, setRestartHint] = react.useState(false);
			const [jobs, setJobs] = react.useState({});
			const [familyCollapsed, setFamilyCollapsed] = react.useState({});
			const [familyCheck, setFamilyCheck] = react.useState({});
			const [query, setQuery] = react.useState(() => {
				try { return localStorage.getItem("pc-market-query") ?? ""; } catch { return ""; }
			});
			const [market, setMarket] = react.useState(null);
			const [marketPage, setMarketPage] = react.useState(1);
			const [loadingMore, setLoadingMore] = react.useState(false);
			const [repoInfo, setRepoInfo] = react.useState(null);
			const [subpackages, setSubpackages] = react.useState(null);
			const [installing, setInstalling] = react.useState(null);
			const [details, setDetails] = react.useState(null);
			// 已安装插件"检测更新"：null=未检测 / {status:'checking'} / {status:'ready', latest, error}
			const [updateCheck, setUpdateCheck] = react.useState(null);
			// 静态插件索引（dsh-plugin topic 全量浏览）：null=未加载 / {items, skills, loaded}
			const [indexData, setIndexData] = react.useState(null);
			// 索引加载失败原因：null = 还没失败过（用于市场页顶部"索引未加载 + 重试"提示）
			const [indexError, setIndexError] = react.useState(null);
			// 索引浏览当前展示条数（分页展示，避免一次渲染 500 条）
			const [indexShown, setIndexShown] = react.useState(50);
			// 已补标（官方/聚合标记）到的索引位置：随「加载更多」增量推进，避免一次性发上千请求
			const [enrichedUpTo, setEnrichedUpTo] = react.useState(0);
			/** 合并一条补标结果（不动已有标记，避免 null 覆盖）。 */
			function mergeEnrichMark(e, b) {
				return {
					...e,
					official: e.official !== null ? e.official : (b?.official ?? null),
					aggregate: e.aggregate === true || b?.aggregate === true,
					aggregateInstallable: b?.aggregateInstallable === true,
					hasSkill: e.hasSkill === true || b?.hasSkill === true,
					hasSuite: e.hasSuite === true || b?.hasSuite === true,
				};
			}
			/** 服务端 /enrich 兜底：并发限流 12 + 24h 缓存，补齐客户端直连失败/遗漏的标记
			 *  （每次最多 30 条，按需分批；结果按位置合并回索引与当前展示切片）。 */
			function enrichRangeServer(from, slice) {
				const BATCH = 30;
				for (let i = 0; i < slice.length; i += BATCH) {
					const batch = slice.slice(i, i + BATCH);
					const start = from + i;
					call("/plugin-console/enrich", { items: batch }).then(
						(r) => {
							if (r === null || !Array.isArray(r.items)) return;
							const got = r.items;
							setIndexData((prev) => {
								if (prev === null || prev.loaded !== true) return prev;
								const items = [...prev.items];
								got.forEach((e, k) => {
									const idx = start + k;
									if (idx < items.length) items[idx] = mergeEnrichMark(e, items[idx]);
								});
								return { ...prev, items };
							});
							setMarket((prev) => {
								if (prev === null || prev.status !== "ready" || prev.fromIndex !== true) return prev;
								return {
									...prev,
									data: prev.data.map((it) => {
										const hit = got.find((e) => e.fullName === it.fullName);
										return hit ? mergeEnrichMark(hit, it) : it;
									}),
								};
							});
						},
						() => {},
					);
				}
			}
			/** 增量补标索引区间 [from, to)：首屏先补前 50 条，之后随「加载更多」继续往下补。 */
			function enrichRange(from, to, list) {
				const slice = (list ?? []).slice(from, to);
				if (slice.length === 0) return;
				enrichOfficialBundle(slice).then((enriched) => {
					if (!Array.isArray(enriched)) return;
					setIndexData((prev) => {
						if (prev === null || prev.loaded !== true) return prev;
						const items = [...prev.items];
						enriched.forEach((e, i) => {
							const idx = from + i;
							if (idx < items.length) items[idx] = mergeEnrichMark(e, items[idx]);
						});
						return { ...prev, items };
					});
					// 同步刷新当前展示的切片（引用变化才会重渲染）
					setMarket((prev) => {
						if (prev === null || prev.status !== "ready" || prev.fromIndex !== true) return prev;
						return {
							...prev,
							data: prev.data.map((it) => {
								const hit = enriched.find((e) => e.fullName === it.fullName);
								return hit ? mergeEnrichMark(hit, it) : it;
							}),
						};
					});
					setEnrichedUpTo((prev) => Math.max(prev, to));
				});
				// ② 服务端 /enrich 兜底：延后 1.5 秒执行（不抢首屏带宽），走 24h 缓存 + 并发限流通道
				if (typeof window.setTimeout === "function") {
					window.setTimeout(() => enrichRangeServer(from, slice), 1500);
				}
			}
			// 市场总模式：'plugins' = 插件市场 / 'skills' = 技能市场（localStorage 持久化）
			const [mode, setMode] = react.useState(() => {
				try { return localStorage.getItem("pc-market-mode") === "skills" ? "skills" : "plugins"; } catch { return "plugins"; }
			});
			// 已安装技能清单（~/.dsh/skills），[{name, dir|file}]，用于技能条目「已装」标记与已安装区展示
			const [installedSkills, setInstalledSkills] = react.useState([]);
			const [pluginSkills, setPluginSkills] = react.useState([]);
			// 原始页面标题（AI 授权标题闪烁后恢复用）
			const originalTitleRef = react.useRef("");
			// 技能删除两步确认：存待确认技能名
			const [confirmSkillDelete, setConfirmSkillDelete] = react.useState(null);
			// 技能停用/启用进行中
			const [togglingSkill, setTogglingSkill] = react.useState(null);
			// 套装安装报告：{ jobId: [{component, type, ok, note}] }
			const [suiteReports, setSuiteReports] = react.useState({});
			// 框架升级提示已关闭（本次会话内）
			const [frameworkNoticeDismissed, setFrameworkNoticeDismissed] = react.useState(false);
			// 进度条已关闭
			const [fwStatusDismissed, setFwStatusDismissed] = react.useState(false);
			// 框架升级：两步确认 + 执行中
			const [confirmFrameworkUpgrade, setConfirmFrameworkUpgrade] = react.useState(false);
			const [frameworkUpgrading, setFrameworkUpgrading] = react.useState(false);
			// 框架升级进度（重连后恢复显示）：{status, message}
			const [frameworkStatus, setFrameworkStatus] = react.useState(null);
			// Hub 自身更新：仅在检测到远程新版时显示下载/更新按钮
			const [selfUpdate, setSelfUpdate] = react.useState(null);
			// 进度条步骤（与 host 脚本 SetState 的阶段对应）
			const FW_STEPS = [
				{ key: "starting", label: t("fwStepBackup") },
				{ key: "stopped", label: t("fwStepStop") },
				{ key: "installing", label: t("fwStepInstall") },
				{ key: "rollback", label: t("fwStepRollback") },
				{ key: "pkg", label: t("fwStepPkg") },
				{ key: "relaunching", label: t("fwStepRelaunch") },
				{ key: "done", label: t("fwStepDone") },
			];
			// 升级进度轮询：页面断开后请求失败自动停止；重连后由挂载恢复逻辑继续
			const fwStatusTimerRef = react.useRef(null);
			const pollFrameworkStatus = () => {
				if (fwStatusTimerRef.current) return;
				fwStatusTimerRef.current = window.setInterval(() => {
					call("/plugin-console/framework-upgrade-status").then(
						(data) => {
							if (data && typeof data.status === "string") {
								setFrameworkStatus(data);
								if (data.status === "done" || data.status === "failed") {
									window.clearInterval(fwStatusTimerRef.current);
									fwStatusTimerRef.current = null;
								}
							}
						},
						() => {}, // 服务断开：轮询失败静默（重连后由挂载逻辑恢复）
					);
				}, 3000);
			};
			// 功能包 → [框架] 常驻面板（用户要求：卡片被关掉后就找不回来了，框架升级/回滚要常驻可入口）
			const [fwPanelOpen, setFwPanelOpen] = react.useState(false);
			const [fwCheck, setFwCheck] = react.useState(null);
			const [fwCheckBusy, setFwCheckBusy] = react.useState(false);
			const [fwConfirmPanel, setFwConfirmPanel] = react.useState(false);
			// 面板里的状态刷新：**无视**「终态已关闭」标记——卡片可以被永久关掉，面板必须永远能查到真相
			const fwStatusRefresh = () => {
				call("/plugin-console/framework-upgrade-status").then(
					(data) => {
						if (data && typeof data.status === "string") {
							setFrameworkStatus(data);
							if (data.status !== "done" && data.status !== "failed") pollFrameworkStatus();
						}
					},
					() => {},
				);
			};
			const fwCheckRefresh = (refresh) => {
				setFwCheckBusy(true);
				call("/plugin-console/framework-check", refresh === true ? { refresh: true } : {}).then(
					(data) => { setFwCheckBusy(false); if (data && data.ok === true) setFwCheck(data); },
					(error) => { setFwCheckBusy(false); setMessage(t("failed") + "：" + friendlyGithubError(error).message); },
				);
			};
			const doFrameworkRollback = () => {
				setFrameworkUpgrading(true);
				call("/plugin-console/framework-rollback", {}).then(
					(data) => {
						setFrameworkUpgrading(false);
						setMessage(t("frameworkRollbackDone").replace("{from}", String(data?.from ?? "?")));
						setFrameworkStatus({ status: "rollback", message: t("frameworkRollbackDone").replace("{from}", String(data?.from ?? "?")) });
						pollFrameworkStatus();
					},
					(error) => { setFrameworkUpgrading(false); setMessage(t("failed") + "：" + friendlyGithubError(error).message); },
				);
			};
			// 回滚按钮可用性：已经处在「回滚目标版本」时不再提供回滚（点了等于恢复现状）。
			// v0.3.41：客户端**自己算**一遍，不只信服务端的 applicable ——
			// 服务端 0.3.38 还没这个字段时（用户实测「明明版本对了回滚还亮着」），
			// 只要 /state 里已有 framework.version 与 rollback.from 就能判定，刷新页面即生效。
			const rollbackInfo = state.status === "ready" ? state.data.rollback : null;
			const curFwVersion = state.status === "ready" && typeof state.data.framework?.version === "string" ? state.data.framework.version : null;
			const rollbackUsable = rollbackInfo !== null && rollbackInfo !== undefined
				&& rollbackInfo.applicable !== false
				&& !(curFwVersion !== null && rollbackInfo.from !== null && rollbackInfo.from !== undefined && curFwVersion === rollbackInfo.from);
			// 升级步骤视图（卡片与常驻面板共用；失败时按 stage 标已完成步骤，不整列红叉）
			const fwStepsView = (st) => {
				const cur = FW_STEPS.findIndex((s) => s.key === st.status);
				const failedStage = st.status === "failed"
					? (st.stage ?? (st.frameworkAtTarget ? "relaunching" : null))
					: null;
				const stageIdx = failedStage ? FW_STEPS.findIndex((s) => s.key === failedStage) : -1;
				return el("ul", { className: styles.market }, FW_STEPS.map((step, idx) => {
					const state2 = st.status === "done"
						? "ok"
						: st.status === "failed"
							? (stageIdx >= 0 ? (idx < stageIdx ? "ok" : (idx === stageIdx ? "fail" : "wait")) : "fail")
							: (idx < cur ? "ok" : (idx === cur ? "cur" : "wait"));
					return el("li", { key: step.key, className: styles.item },
						el("div", { className: styles.itemTop },
							el("code", { className: styles.name }, (state2 === "ok" ? "✓ " : state2 === "cur" ? "⟳ " : state2 === "fail" ? "✕ " : "· ") + step.label),
							state2 === "cur" ? el("span", { className: styles.spinner }) : null));
				}));
			};
			// 挂载/重连后恢复升级进度（若上次升级仍在进行/刚完成）
			react.useEffect(() => {
				call("/plugin-console/framework-upgrade-status").then(
					(data) => {
						// 状态照收（[框架] 按钮角标与常驻面板都要用）；**卡片是否显示**由 fwShowCard 统一决定，
						// 不再在这里用 localStorage 标记把状态整个吞掉（那会让角标也瞎掉）。
						if (data && typeof data.status === "string" && data.status !== "idle") {
							setFrameworkStatus(data);
							if (data.status !== "done" && data.status !== "failed") pollFrameworkStatus();
						}
					},
					() => {},
				);
				return () => { if (fwStatusTimerRef.current) { window.clearInterval(fwStatusTimerRef.current); fwStatusTimerRef.current = null; } };
			}, []);
			// 自动版本比对结果：{ fullName: latest }（已安装且有新版）
			const [updateMap, setUpdateMap] = react.useState({});
			const [expandedDescs, setExpandedDescs] = react.useState({});
			const [installedQuery, setInstalledQuery] = react.useState(() => {
				try { return localStorage.getItem("pc-market-installed-q") ?? ""; } catch { return ""; }
			});
			const [installedSearchOpen, setInstalledSearchOpen] = react.useState(false);
			const [extraOnly, setExtraOnly] = react.useState(true);
			// 点击切换时的高亮闪烁（1.5 秒后渐变回落）
			const [extraFlash, setExtraFlash] = react.useState(false);
			const [officialOnly, setOfficialOnly] = react.useState(() => {
				try { return localStorage.getItem("pc-market-official") === "1"; } catch { return false; }
			});
			// 多源汇总搜索（GitHub + 全部自定义源并行），localStorage 持久化
			const [multiSource, setMultiSource] = react.useState(() => {
				try { return localStorage.getItem("pc-multi-source") === "1"; } catch { return false; }
			});
			const [confirmDeleteRowId, setConfirmDeleteRowId] = react.useState(null);
			const [deleteBusy, setDeleteBusy] = react.useState(null);
			// AI 兜底开关（默认开启，零费用保障）：关掉后常规通道失败即取消，不调用模型 API
			const [aiFallback, setAiFallback] = react.useState(() => {
				try { return localStorage.getItem("pc-ai-fallback-v2") !== "off"; } catch { return true; }
			});
			// AI 赋能：来源输入 / 计划确认 / 执行进度
			const [aiOpen, setAiOpen] = react.useState(false);
			const [aiSource, setAiSource] = react.useState("");
			const [aiJob, setAiJob] = react.useState(null);
			const [aiSelected, setAiSelected] = react.useState({});
			const [aiRunning, setAiRunning] = react.useState(false);
			const [aiJobsList, setAiJobsList] = react.useState([]);
			// 并发任务列表：轻量视图轮询（服务端支持并行多个 AI 赋能）
			async function refreshAiList() {
				try {
					const data = await call("/plugin-console/ai-empower/list", {});
					if (data && data.ok === true) setAiJobsList(data.tasks ?? []);
				} catch {}
			}
			function aiSelect(jobId) {
				if (aiJob !== null && aiJob.jobId === jobId) return;
				setAiJob(null);
				setAiRunning(true);
				aiPoll(jobId);
			}
			// 服务器组件清单（AI 赋能注册的服务型组件）
			const [comps, setComps] = react.useState([]);
			const [compBusy, setCompBusy] = react.useState(null);
			const [compDropOpen, setCompDropOpen] = react.useState(false);
			const [compCollapsed, setCompCollapsed] = react.useState(() => {
				try { return localStorage.getItem("pc-comp-collapsed") === "1"; } catch { return false; }
			});
			const [toolbarOpen, setToolbarOpen] = react.useState(() => {
				try { return localStorage.getItem("pc-toolbar-open") === "1"; } catch { return false; }
			});
			// 门控面板（用户要求：总开关收进「功能包」里的 [门控] 按钮，不再占已安装列表的表头）
			const [gateOpen, setGateOpen] = react.useState(false);
			// 功能包位置:长按拖动,持久化 localStorage(每次打开沿用上次位置)
			const [toolbarPos, setToolbarPos] = react.useState(() => {
				try {
					const v = JSON.parse(localStorage.getItem("pc-toolbar-pos") || "null");
					if (v && Number.isFinite(v.left) && Number.isFinite(v.top)) return { left: v.left, top: v.top };
				} catch {}
				return null;
			});
			const [dragPos, setDragPos] = react.useState(null);
			const dragRef = react.useRef({ long: null, active: false, justDragged: false, grabX: 0, grabY: 0, base: null });
			const [repoLandOn, setRepoLandOn] = react.useState(() => {
				try { return localStorage.getItem("pc-repo-land") === "1"; } catch { return false; }
			});
			const [repoLandOpen, setRepoLandOpen] = react.useState(false);
			const [repoLandInput, setRepoLandInput] = react.useState("");
			const [repoLandBusy, setRepoLandBusy] = react.useState(false);
			const [repoLandResult, setRepoLandResult] = react.useState(null);
			const [repoLanded, setRepoLanded] = react.useState([]);
			const [repoLandDir, setRepoLandDir] = react.useState("");
			const [repoLandDirInput, setRepoLandDirInput] = react.useState("");
			async function repoLandRefresh() {
				try {
					const data = await call("/plugin-console/repo-list", {});
					if (data && data.ok === true) {
						setRepoLanded(data.repos ?? []);
						setRepoLandDir(data.dir ?? "");
						setRepoLandDirInput(data.dir ?? "");
					}
				} catch {}
			}
			async function repoLandEntry(repo) {
				setRepoLandResult(null);
				try {
					const data = await call("/plugin-console/repo-clone", { repo });
					if (data && data.ok === true) setRepoLandResult({ ok: true, path: data.path });
				} catch (error) {
					setRepoLandResult({ ok: false, error: error.message });
				}
				repoLandRefresh();
			}
			async function repoLandSaveDir() {
				const dir = repoLandDirInput.trim();
				if (dir === "") return;
				try {
					const data = await call("/plugin-console/repo-land-config", { dir });
					if (data && data.ok === true) { setRepoLandDir(data.dir); repoLandRefresh(); }
				} catch (error) {
					setRepoLandResult({ ok: false, error: error.message });
				}
			}
			async function repoLandRemove(item) {
				if (!window.confirm(t("repoLandRemoveConfirm").replace("{repo}", item.repo))) return;
				try {
					await call("/plugin-console/repo-remove", { path: item.path });
				} catch {}
				repoLandRefresh();
			}
			async function repoLandStart() {
				const repo = repoLandInput.trim();
				if (repo === "" || repoLandBusy) return;
				setRepoLandBusy(true);
				setRepoLandResult(null);
				try {
					const data = await call("/plugin-console/repo-clone", { repo });
					if (data && data.ok === true) setRepoLandResult({ ok: true, path: data.path });
				} catch (error) {
					setRepoLandResult({ ok: false, error: error.message });
				}
				setRepoLandBusy(false);
			}
			async function repoLandOpenFolder() {
				if (repoLandResult === null || repoLandResult.ok !== true) return;
				try { await call("/plugin-console/repo-open", { path: repoLandResult.path }); } catch {}
			}
			const sectionRef = react.useRef(null);
			const [compCardTop, setCompCardTop] = react.useState(null);
			function measureCompCardTop() {
				const host = sectionRef.current;
				if (!host) return;
				const secTop = host.getBoundingClientRect().top;
				let top = secTop;
				let node = host.parentElement;
				while (node) {
					const r = node.getBoundingClientRect();
					if (r.height > 10 && r.height <= 1600) {
						if (r.top < top - 28) { top = r.top; break; }
						if (r.top > top + 2) break;
					}
					node = node.parentElement;
				}
				setCompCardTop(`${Math.max(8, Math.round(top))}px`);
			}
			async function refreshComps() {
				try {
					const data = await call("/plugin-console/components", {});
					if (data && data.ok === true) setComps(data.components ?? []);
					else setComps([]);
				} catch { setComps([]); }
				window.setTimeout(measureCompCardTop, 50);
			}
			async function aiPoll(jobId) {
				try {
					const data = await call("/plugin-console/ai-empower/status", { jobId });
					refreshAiList();
					if (data && data.ok === true) {
						setAiJob(data);
						if (data.status === "running") {
							window.setTimeout(() => aiPoll(jobId), 2500);
							return;
						}
						if (data.status === "plan-ready") {
							const sel = {};
							for (const s of data.steps ?? []) sel[s.index] = true;
							setAiSelected(sel);
						}
						setAiRunning(false);
						refreshComps();
					}
				} catch (error) {
					// 任务已失效（如 DSH 重启导致内存任务丢失）：清理本地记忆，下次挂载不再恢复
					if (/没有这个 AI 赋能任务/.test(error.message)) {
						try { localStorage.removeItem("pc-ai-job"); } catch {}
						setAiJob({ jobId: null, source: "", status: "failed", stage: "gone", error: "上次 AI 赋能任务已失效（DSH 重启中断），请重新发起" });
					} else {
						setAiJob((prev) => ({ ...(prev ?? {}), status: "failed", error: error.message }));
					}
					setAiRunning(false);
				}
			}
			function openAiFor(source) {
				setAiSource(String(source ?? ""));
				setAiJob(null);
				setAiRunning(false);
				setAiOpen(true);
			}
			async function aiStartPlan() {
				const source = aiSource.trim();
				if (source === "") return;
				setAiJob(null);
				setAiRunning(true);				try {
					const data = await call("/plugin-console/ai-empower/plan", { source });
					if (data && data.ok === true) {
						try { localStorage.setItem("pc-ai-job", data.jobId); } catch {}
						setAiJob({ jobId: data.jobId, source, status: "running", stage: "planning" });
						aiPoll(data.jobId);
					}
					else { setAiRunning(false); setMessage(t("failed") + "：" + (data?.error ?? "未知")); }
				} catch (error) {
					setAiRunning(false);
					setMessage(t("failed") + "：" + friendlyGithubError(error).message);
				}
			}
			async function aiRun() {
				if (aiJob === null || aiJob.status !== "plan-ready") return;
				const steps = (aiJob.steps ?? []).map((s) => s.index).filter((i) => aiSelected[i]);
				if (steps.length === 0) {
					setMessage(t("aiEmpowerNeedSteps"));
					return;
				}
				if (!window.confirm(t("aiConfirmDeploy").replace("{n}", String(steps.length)).replace("{name}", aiJob.displayName ?? aiJob.source))) {
					return;
				}
				setAiRunning(true);
				try {
					await call("/plugin-console/ai-empower/run", { jobId: aiJob.jobId, steps, confirmed: true });
					aiPoll(aiJob.jobId);
				} catch (error) {
					setAiRunning(false);
					setMessage(t("failed") + "：" + friendlyGithubError(error).message);
				}
			}
			async function aiCancel() {
				if (aiJob === null) return;
				try { await call("/plugin-console/ai-empower/cancel", { jobId: aiJob.jobId }); } catch {}
				setAiRunning(false);
				await aiPoll(aiJob.jobId).catch(() => {});
			}
			// 「取消」= 彻底终止并回到普通面板：清空任务状态 + 本地任务记忆（重开不再恢复旧任务）
			function aiResetLocal() {
				try { localStorage.removeItem("pc-ai-job"); } catch {}
				setAiJob(null);
				setAiRunning(false);
			}
			async function compAction(id, action) {
				setCompBusy(id);
				try {
					const data = await call("/plugin-console/component/" + action, { id });
					setMessage(t("compActionDone").replace("{action}", t(action === "start" ? "compStart" : "compStop")).replace("{name}", data?.name ?? id));
				} catch (error) {
					setMessage(t("failed") + "：" + error.message);
				}
				setCompBusy(null);
				refreshComps();
			}
			async function compStatusOne(id) {
				setCompBusy(id);
				try {
					const data = await call("/plugin-console/component/status", { id });
					if (data && data.ok === true) {
						setMessage(data.running ? (data.healthy ? t("compHealthy") : t("compUnhealthy")) + "：" + (data.name ?? id) : t("compStopped") + "：" + (data.name ?? id));
					}
				} catch (error) {
					setMessage(t("failed") + "：" + error.message);
				}
				setCompBusy(null);
				refreshComps();
			}
			// 面板重开时恢复 AI 赋能任务（服务端任务常驻内存+持久化，前端只需恢复轮询——关闭面板不会中断赋能）
			react.useEffect(() => {
				refreshAiList();
				repoLandRefresh();
				try {
					const jid = localStorage.getItem("pc-ai-job");
					if (jid) { setAiRunning(true); aiPoll(jid); }
				} catch {}
			}, []);
			async function compAuto(id, on) {				setCompBusy(id);
				try {
					await call("/plugin-console/component/autostart", { id, enabled: on });
					setMessage((on ? "✔ 已开启自启动：" : "已关闭自启动：") + id);
				} catch (error) {
					setMessage(t("failed") + "：" + error.message);
				}
				setCompBusy(null);
				refreshComps();
			}
			const aiAutoDeclinedRef = react.useRef({});
			react.useEffect(() => {
				if (state.status === "ready") { refreshComps(); window.setTimeout(measureCompCardTop, 120); }
			}, [state.status]);
			// 已关闭的失败提示（用户点 × 后不再显示，服务重启后重置）
			const [dismissedFailures, setDismissedFailures] = react.useState({});
			// 软件源管理
			const [sourcesOpen, setSourcesOpen] = react.useState(false);
			const [sourcesData, setSourcesData] = react.useState(null);
			const [sourceName, setSourceName] = react.useState("");
			const [sourceUrl, setSourceUrl] = react.useState("");
			const [sourcesBusy, setSourcesBusy] = react.useState(false);
			// 软件源扫描结果：null=未扫描 / {status:'scanning'} / {status:'ready', results, scannedAt}
			const [regScan, setRegScan] = react.useState(null);
			// registry 行内编辑
			const [editReg, setEditReg] = react.useState(null);
			const [indexSourceName, setIndexSourceName] = react.useState("");
			const [indexSourceUrl, setIndexSourceUrl] = react.useState("");
			const [editIndex, setEditIndex] = react.useState(null);
			const [gitSourceName, setGitSourceName] = react.useState("");
			const [gitSourceUrl, setGitSourceUrl] = react.useState("");
			const [editGit, setEditGit] = react.useState(null);
			// 软件源弹窗折叠分区：软件源默认展开，其余收起（避免弹窗过长）
			const [openSections, setOpenSections] = react.useState({ registries: true, index: false, git: false, search: false, gitee: false });
			// 搜索源列表（内置 + 自定义，来自配置）
			const [searchSourcesList, setSearchSourcesList] = react.useState(null);
			// Git 源列表（「仓库落地」提示动态显示当前主源，避免写死 GitHub）
			const [gitSourcesList, setGitSourcesList] = react.useState(null);
			// 自定义搜索源添加表单
			const [searchSourceName, setSearchSourceName] = react.useState("");
			const [searchSourceUrl, setSearchSourceUrl] = react.useState("");
			// 自定义源请求头（每行 "名称: 值"，保存时解析）
			const [searchSourceHeaders, setSearchSourceHeaders] = react.useState("");
			// Gitee OAuth
			const [giteeClientId, setGiteeClientId] = react.useState("");
			const [giteeClientSecret, setGiteeClientSecret] = react.useState("");
			// 派生：Gitee 登录状态
			const giteeStatus = sourcesData !== null
				? { clientConfigured: !!sourcesData.gitee?.clientConfigured, hasToken: !!sourcesData.gitee?.hasToken, login: sourcesData.gitee?.login ?? "" }
				: null;
			// 搜索源（默认 GitHub；点击登录标切换），localStorage 持久化
			const [searchSource, setSearchSource] = react.useState(() => {
				try { const s = localStorage.getItem("pc-search-source"); return s === "gitee" ? s : "github"; } catch { return "github"; }
			});
			const [sourceMenuOpen, setSourceMenuOpen] = react.useState(false);
			// GitHub 登录：徽章点开内联面板，token 只在「浏览器 → 本机服务端」之间走，服务端不回显
			const [ghLoginOpen, setGhLoginOpen] = react.useState(false);
			const [ghToken, setGhToken] = react.useState("");
			const [ghLoginBusy, setGhLoginBusy] = react.useState(false);
			// "不再提醒"：勾选后 AI 兜底自动同意，不再弹窗（可在市场底部恢复提醒）
			const [aiRemember, setAiRemember] = react.useState(() => {
				try { return localStorage.getItem("pc-ai-remember") === "1"; } catch { return false; }
			});
			const [showBackTop, setShowBackTop] = react.useState(false);
			const [marketCollapsed, setMarketCollapsed] = react.useState(false);
			// 下滑超过搜索框顶部时浮现"回到搜索"↑按钮
			react.useEffect(() => {
				const onScroll = () => {
					const node = document.getElementById("pc-market-search");
					setShowBackTop(node ? node.getBoundingClientRect().top < -24 : false);
				};
				window.addEventListener("scroll", onScroll, true);
				window.addEventListener("resize", onScroll);
				onScroll();
				return () => {
					window.removeEventListener("scroll", onScroll, true);
					window.removeEventListener("resize", onScroll);
				};
			}, []);
			// 挂载时拉取软件源配置（搜索源菜单用，含自定义源）
			react.useEffect(() => {
				call("/plugin-console/sources").then(
					(data) => {
						setSearchSourcesList(data.sources.searchSources ?? []);
						setGitSourcesList(data.sources.gitSources ?? []);
					},
					() => {},
				);
			}, []);
			// 加载静态插件索引（GitHub 源空查询时秒开浏览，零 API 调用）。
			// 失败时记下原因：市场页顶部给出"索引未加载 → 只能搜 GitHub 实时结果"的提示 + 重试按钮
			//（2026-09-20 事故：另一位用户索引源全挂 + 未登录，三条检索路全断，搜 web-all 搜不到 dsh-web，
			//  而界面上只有一句"市场索引加载失败"，看不出后果也没有重试入口）
			const loadMarketIndex = () => {
				call("/plugin-console/market-index", {}).then(
					(data) => {
						if (data && Array.isArray(data.items)) {
							setIndexError(null);
							setIndexData({
								items: data.items,
								skills: Array.isArray(data.skills) ? data.skills : [],
								loaded: true,
								offline: data.offline === true,
								cachedAt: typeof data.cachedAt === "number" ? data.cachedAt : null,
								sourceName: typeof data.sourceName === "string" ? data.sourceName : null,
							});
							// ★「只看官方」需要官方标记：先补首屏 50 条，其余随「加载更多」增量补
							//（每条要发网络请求，全量 500 条会打满浏览器连接数，导致打开插件页明显变慢）
							const runEnrich = () => enrichRange(0, 50, data.items);
							if (typeof window.requestIdleCallback === "function") {
								window.requestIdleCallback(() => runEnrich(), { timeout: 2000 });
							} else {
								window.setTimeout(runEnrich, 400);
							}
						}
					},
					(error) => {
						const text = error?.message ?? t("unknown");
						setIndexError(text);
						setMessage(t("marketIndexFailed") + "：" + text);
					},
				);
			};
			react.useEffect(() => {
				loadMarketIndex();
				// 市场状态记忆：关闭前搜索过 → 重开时自动恢复该搜索（query 已从 localStorage 初始化）
				if (query !== "") {
					search();
				}
			}, []);
			// 挂载时记录原始标题（AI 授权标题闪烁后恢复用）
			react.useEffect(() => {
				try { originalTitleRef.current = document.title; } catch {}
			}, []);
			// 挂载时拉取已安装技能清单（技能条目「已装」标记用）
			react.useEffect(() => {
				call("/plugin-console/skills-installed").then(
					(data) => {
						if (data && Array.isArray(data.skills)) setInstalledSkills(data.skills);
						if (data && Array.isArray(data.pluginSkills)) setPluginSkills(data.pluginSkills);
					},
					() => {},
				);
			}, []);
			// 自动版本比对：市场数据中已安装的条目，后台查 registry 最新版，有新版则卡片显示「更新」。
			// 官方框架组件（@deepseek-ai/* 且 repository 指向 deepseek-harness）随框架版本配套发布，
			// 单独更新会版本混搭——排除；且必须 latest !== 已装版本才显示（避免恒显示「更新」）。
			react.useEffect(() => {
				if (market === null || market.status !== "ready" || state.status !== "ready") return;
				const matched = market.data
					.map((item) => ({
						item,
						entry: state.data.entries.find((candidate) =>
							(candidate.repository && candidate.repository.includes(item.fullName.toLowerCase()))
							|| moduleShortName(candidate.moduleName) === item.fullName.toLowerCase().split("/")[1]),
					}))
					.filter(({ entry }) => entry !== undefined && entry.moduleName !== undefined)
					// 排除官方框架组件：@deepseek-ai/* 且仓库指向 deepseek-harness（框架本体及其配套子包）
					.filter(({ entry }) => !(entry.repository && entry.repository.includes("deepseek-ai/deepseek-harness")
						&& String(entry.moduleName).startsWith("@deepseek-ai/")))
					.slice(0, 6);
				// 框架本体特判：deepseek-harness 仓库 → 查 @deepseek-ai/dsh（框架包）版本，
				// 有新版则卡片显示「框架升级 → vX」（点击走 /framework-upgrade：备份配置 + 升级指引 + 适配）
				const fwItem = market.data.find((item) => item.fullName === "deepseek-ai/deepseek-harness");
				if (fwItem) {
					call("/plugin-console/check-update", { packageName: "@deepseek-ai/dsh" }).then(
						(data) => {
							if (data && data.error === null) {
								const current = state.data.compat?.dshVersion ?? "";
								// 通用 semver 比较（支持 0.1.0-rc.8 → 0.1.1-rc.2 跨 minor 升级；0.1.1-rc.N 不再写死 0.1.0）
								const verNum = (v) => {
									const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:[a-z]+\.)?(\d+))?$/iu);
									if (!m) return -1;
									const [ , maj, min, pat, rc ] = m;
									// 正式版（无 rc）视为 rc.∞：0.1.1 > 0.1.1-rc.2
									return { maj: parseInt(maj, 10), min: parseInt(min, 10), pat: parseInt(pat, 10), rc: rc === undefined ? Number.POSITIVE_INFINITY : parseInt(rc, 10) };
								};
								const isNewer = (a, b) => {
									if (a === -1 || b === -1) return false;
									if (a.maj !== b.maj) return a.maj > b.maj;
									if (a.min !== b.min) return a.min > b.min;
									if (a.pat !== b.pat) return a.pat > b.pat;
									return a.rc > b.rc;
								};
								// 稳定版 latest 优先；latest 不高于当前而 next（预发布渠道）更高时，目标取 next
								const target = data.latest && isNewer(verNum(data.latest), verNum(current))
									? data.latest
									: (data.next && isNewer(verNum(data.next), verNum(current)) ? data.next : null);
								if (target) setUpdateMap((prev) => ({ ...prev, [fwItem.fullName]: target }));
							}
						},
						() => {},
					);
				}
				if (matched.length === 0) return;
				let done = 0;
				const run = () => {
					if (done >= matched.length) return;
					const { item, entry } = matched[done];
					done += 1;
					call("/plugin-console/check-update", { packageName: entry.moduleName }).then(
						(data) => {
							if (data && data.latest && data.error === null && data.latest !== entry.version) {
								setUpdateMap((prev) => ({ ...prev, [item.fullName]: data.latest }));
							}
						},
						() => {},
					).then(run, run);
				};
				run();
			}, [market, state]);
			// Hub 自身更新检测：semver 比较，且识别 beta/next 测试版（本地已是测试版最新则不提示）
			react.useEffect(() => {
				if (state.status !== "ready") return;
				const current = state.data.selfVersion ?? null;
				if (!current) return;
				const ver = (v) => {
					try {
						const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
						return m ? Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]) : 0;
					} catch { return 0; }
				};
				call("/plugin-console/check-update", { packageName: "@noob-stupid/dsh-plugin-console" }).then(
					(data) => {
						if (data && data.error === null) {
							const candidates = [data.latest, data.next, data.beta].filter((v) => typeof v === "string" && v !== "");
							let better = null;
							for (const v of candidates) {
								if (ver(v) > ver(current) && (better === null || ver(v) > ver(better))) better = v;
							}
							setSelfUpdate(better === null ? null : { latest: better });
						} else {
							setSelfUpdate(null);
						}
					},
					() => setSelfUpdate(null),
				);
			}, [state]);
			// 搜索源菜单：点击外部收起
			react.useEffect(() => {
				if (!sourceMenuOpen) return;
				const onDown = (event) => {
					const area = document.getElementById("pc-ghwrap");
					if (area && !area.contains(event.target)) setSourceMenuOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [sourceMenuOpen]);
			// 已安装搜索：点击搜索区以外且无内容时立即收起（无延迟）
			react.useEffect(() => {
				if (!installedSearchOpen) return;
				const onDown = (event) => {
					const area = document.getElementById("pc-installed-search-area");
					if (area && !area.contains(event.target) && installedQuery.trim() === "") {
						setInstalledSearchOpen(false);
					}
				};
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [installedSearchOpen, installedQuery]);
			const refresh = react.useCallback(() => {
				setState((prev) => ({ ...prev, status: "loading" }));
				call("/plugin-console/state").then(
					(data) => {
						setState({ status: "ready", data });
						// 恢复进行中的安装任务轮询（离开面板再回来也能看到进度）
						for (const job of data.installJobs ?? []) {
							setJobs((prev) => ({ ...prev, [job.jobId]: job }));
							pollJob(job.jobId);
						}
					},
					() => setState({ status: "error" }),
				);
			}, []);
			react.useEffect(() => { refresh(); }, [refresh]);
			// ── GitHub 登录态的两个读数：面板里多处要用（徽章文案、菜单项、内联子面板）──
			const ghAuthed = state.status === "ready" && state.data.github !== undefined && state.data.github.loggedIn === true;
			const ghLoginName = state.status === "ready" && state.data.github !== undefined && state.data.github.login !== null && state.data.github.login !== undefined
				? state.data.github.login
				: "unknown";
			// 设备码登录的轮询句柄：拿到登录态就停，用户手动收起菜单也停（不留后台空转的定时器）
			const ghPollRef = react.useRef(null);
			const stopGhPoll = react.useCallback(() => {
				if (ghPollRef.current !== null) { window.clearInterval(ghPollRef.current); ghPollRef.current = null; }
			}, []);
			// 组件卸载时收尾（本面板是长驻 UI，正常不卸载，但热重载/关闭面板会）
			react.useEffect(() => () => stopGhPoll(), [stopGhPoll]);
			// 菜单收起 = 用户手动关掉了这次登录尝试 → 立刻停止轮询（对应"最多 60s 或用户手动关闭"）
			react.useEffect(() => { if (!sourceMenuOpen) stopGhPoll(); }, [sourceMenuOpen, stopGhPoll]);
			// 窗口登录开始后等登录态：每 2s 问一次 /state，最多 60s。
			// 为什么只能轮询：设备码流程在**另一个进程**里完成（用户在 GitHub 页面上输验证码授权），
			// 本插件收不到任何回调，只能盯 <DSH_HOME>/github-auth.json（/state 的 github 字段）有没有变。
			const startGhPoll = () => {
				stopGhPoll();
				const deadline = Date.now() + 60000;
				ghPollRef.current = window.setInterval(() => {
					call("/plugin-console/state").then(
						(snap) => {
							const github = snap !== null && snap !== undefined ? snap.github : null;
							if (github !== null && github !== undefined && github.loggedIn === true) {
								stopGhPoll();
								setMessage(t("githubLoginOk").replace("{login}", github.login ?? ""));
								refresh();
								return;
							}
							if (Date.now() >= deadline) stopGhPoll();
						},
						// 单次失败不中断：授权期间用户可能正在重启服务，下一拍再问
						() => { if (Date.now() >= deadline) stopGhPoll(); },
					);
				}, 2000);
			};
			// 菜单里的主入口「GitHub 登录」：首选设备码窗口流程（在 GitHub 页面上输验证码），
			// 通道不可用才降级到 token 粘贴子面板（token 是兜底，不是正路）。
			const githubOpenLogin = () => {
				if (ghLoginBusy) return;
				setGhLoginBusy(true);
				// 先给一句反馈：环回调用最长要等 8s，中间没有提示会让人以为点了没反应
				setMessage(t("githubLoginOpened"));
				call("/plugin-console/github-open-login", {}).then(
					(r) => {
						setGhLoginBusy(false);
						if (r !== null && r !== undefined && r.started === true) {
							setMessage(t("githubLoginOpened"));
							startGhPoll();
							return;
						}
						// 服务端回 started:false 时一定带 reason（插件没装/没有 exe/平台不支持），照念给用户
						setMessage(t("githubLoginUnavailable") + "：" + (r !== null && r !== undefined && typeof r.reason === "string" ? r.reason : ""));
						setGhLoginOpen(true);
					},
					(error) => {
						setGhLoginBusy(false);
						setMessage(t("githubLoginFail") + "：" + (error?.message ?? ""));
						setGhLoginOpen(true);
					},
				);
			};
			// 粘贴 token 登录：成功后清空输入 + 收起面板 + 刷新登录态（让徽章/代码搜索立刻用上新身份）；
			// 失败**不清空输入**——用户多半是复制时多带了空格/少了一段，保留原文才好改。
			const githubLogin = () => {
				const token = ghToken.trim();
				if (token === "" || ghLoginBusy) return;
				setGhLoginBusy(true);
				call("/plugin-console/github-login", { token }).then(
					(r) => {
						setGhLoginBusy(false);
						setMessage(t("githubLoginOk").replace("{login}", r?.login ?? ""));
						setGhToken("");
						setGhLoginOpen(false);
						refresh();
					},
					(error) => {
						setGhLoginBusy(false);
						setMessage(t("githubLoginFail") + "：" + (error?.message ?? ""));
					},
				);
			};
			const loadDetails = (entry) => {
				if (details !== null && details.entryId === entry.entryId) {
					setDetails(null);
					setUpdateCheck(null);
					return;
				}
				setDetails({ entryId: entry.entryId, status: "loading" });
				setUpdateCheck(null);
				call("/plugin-console/details", { entryId: entry.entryId }).then(
					(data) => setDetails({ entryId: entry.entryId, status: "ready", data }),
					(error) => setDetails({ entryId: entry.entryId, status: "error", error }),
				);
			};
			const checkUpdate = (entry) => {
				const pkgName = entry.moduleName;
				setUpdateCheck({ status: "checking" });
				call("/plugin-console/check-update", { packageName: pkgName }).then(
					(data) => setUpdateCheck({ status: "ready", latest: data.latest ?? null, source: data.source ?? "npm", error: data.error ?? null }),
					(error) => setUpdateCheck({ status: "ready", latest: null, source: "npm", error: friendlyGithubError(error).message }),
				);
			};
			const toggle = (entry, enabled, confirmRisky = false) => {
				setBusy(entry.entryId);
				setMessage(null);
				call("/plugin-console/toggle", { entryId: entry.entryId, enabled, confirmRisky }).then(
					() => {
						setRiskyConfirm(null);
						setMessage(t(enabled ? "toggledOn" : "toggledOff") + "：" + entry.entryId + "。" + t("autoReload"));
						// HMR 应用补丁后自动强刷页面，让客户端插件的挂载/卸载即时可见
						window.setTimeout(() => window.location.reload(), 1500);
					},
					(error) => {
						// 适配门软禁（用户定案）：服务端不直接拒绝，而是要求确认 → 弹风险提示，由你决定开不开
						const details = error !== null && typeof error === "object" ? error.details : null;
						if (details !== null && details !== undefined && details.code === "compat-confirm") {
							setRiskyConfirm({ entryId: entry.entryId, moduleName: details.moduleName ?? entry.moduleName ?? null, frameworkVersion: details.frameworkVersion ?? null, checkNote: details.checkNote ?? null });
							return;
						}
						setMessage(t("failed") + "：" + friendlyGithubError(error).message);
					},
				).finally(() => setBusy(null));
			};
			/** 兼容门总开关：autoDisable（升级时自动禁用不适配）/ autoDetect（打开时自动检测已适配）。 */
			const setCompatGate = (patch) => {
				call("/plugin-console/compat-gate", patch).then(
					(data) => {
						setState((prev) => (prev !== null && prev.status === "ready"
							? { ...prev, data: { ...prev.data, compatGate: data.compatGate } }
							: prev));
						setMessage(t("compatGateSaved"));
					},
					(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
				);
			};
			const levenshtein = (a, b) => {
				const m = a.length, n = b.length;
				if (m === 0) return n;
				if (n === 0) return m;
				const dp = new Array(n + 1);
				for (let j = 0; j <= n; j++) dp[j] = j;
				for (let i = 1; i <= m; i++) {
					let prev = dp[0];
					dp[0] = i;
					for (let j = 1; j <= n; j++) {
						const tmp = dp[j];
						dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
						prev = tmp;
					}
				}
				return dp[n];
			};
			// 本地索引模糊匹配：子串命中优先；其次编辑距离 ≤2 近似（opviking → OpenViking 这类）
			const fuzzyMatchIndex = (q, items) => {
				const ql = q.trim().toLowerCase();
				if (ql === "") return [];
				const scored = [];
				for (const it of items) {
					const text = String(it.fullName ?? it.name ?? it.repository ?? "").toLowerCase();
					const desc = String(it.description ?? "").toLowerCase();
					if (text.includes(ql) || desc.includes(ql)) {
						scored.push({ it, s: 100000 - text.length + (text.startsWith(ql) ? 10000 : 0) });
						continue;
					}
					if (ql.length < 4) continue;
					const tokens = text.split(/[-_/.]/u).filter(Boolean);
					let best = Infinity;
					for (const tk of tokens) best = Math.min(best, levenshtein(ql, tk));
					const qTokens = ql.split(/[\s\-_/.]+/u).filter(Boolean);
					for (const qt of qTokens) for (const tk of tokens) best = Math.min(best, levenshtein(qt, tk));
					if (best <= 2) scored.push({ it, s: 1000 - best * 100 });
				}
				scored.sort((a, b) => b.s - a.s);
				return scored.slice(0, 12).map((x) => x.it);
			};
			/** 合并服务端"增量检索"结果（npm 包名映射 / in:readme 重查 / 代码搜索子包）：
			 * npm 命中置顶，其余按增量顺序追加，最后接原有直连结果，全部按 fullName 去重。
			 * 背景（2026-09-20）：浏览器直连 GitHub 搜索成功时不会走服务端路由，而未登录用户恰恰只能走直连
			 * →「只存在于 npm 包名 / README / 仓库文件里」的名字（如 web-all）永远补不上。 */
			function mergeSearchExtras(base, extras) {
				const seen = new Set();
				const npm = [];
				const rest = [];
				for (const it of extras) {
					const key = it.fullName ?? JSON.stringify(it);
					if (seen.has(key)) continue;
					seen.add(key);
					if (it.npmPackage === true) npm.push(it); else rest.push(it);
				}
				const out = [...npm, ...rest];
				for (const it of base) {
					const key = it.fullName ?? JSON.stringify(it);
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(it);
				}
				return out;
			}
			/** 用 enrich 结果**就地更新**市场列表（按 fullName 打补丁），而不是整表替换——
			 * 否则并行补进来的「增量检索」条目（npm 包名/子包）会被 enrich 回调冲掉。 */
			const applyEnriched = (enriched) => setMarket((m) => {
				if (m === null || m.status !== "ready" || !Array.isArray(enriched)) return m;
				const byName = new Map(enriched.map((x) => [x.fullName, x]));
				return { ...m, data: m.data.map((x) => byName.get(x.fullName) ?? x) };
			});
			const search = () => {
				setMarket({ status: "loading" });
				setRepoInfo(null);
				setMarketPage(1);
				// 技能模式：仅 GitHub 源；空查询 → 技能静态索引（秒开），非空 → 服务端三 topic 合并检索
				if (mode === "skills") {
					if (searchSource !== "github" || multiSource) {
						setMarket({ status: "error", error: new Error(t("skillsGithubOnly")) });
						return;
					}
					if (query.trim() === "" && indexData !== null && indexData.loaded) {
						setMarket({ status: "ready", data: indexData.skills.slice(0, indexShown), direct: false, source: "github", fromIndex: true });
						return;
					}
					call("/plugin-console/search", { q: query, page: 1, skills: true }).then(
						(data) => { setMarket({ status: "ready", data: data.items, direct: false, source: "github", skills: true }); },
						(error) => setMarket({ status: "error", error: friendlyGithubError(error) }),
					);
					return;
				}
				// 静态索引浏览：GitHub 源 + 空查询时展示 dsh-plugin topic 全量索引（秒开、零 API 调用）
				if (searchSource === "github" && !multiSource && query.trim() === "" && indexData !== null && indexData.loaded) {
					setMarket({ status: "ready", data: indexData.items.slice(0, indexShown), direct: false, source: "github", fromIndex: true });
					return;
				}
				// 本地索引模糊匹配：非空查询先对静态索引做近似匹配（opviking → OpenViking），命中即展示（置顶、秒开）
				// 仓库落地开关点亮（全库搜索）时跳过本地索引（本地只有 dsh-plugin 收录），走全库动态
				if (searchSource === "github" && !multiSource && !repoLandOn && indexData !== null && indexData.loaded && query.trim() !== "") {
					const local = fuzzyMatchIndex(query, indexData.items);
					if (local.length > 0) {
						setMarket({ status: "ready", data: local, direct: false, source: "github", fromIndex: true, fuzzy: true });
						return;
					}
				}
				if (multiSource) {
					// 多源汇总：GitHub + 全部自定义源并行（服务端合并，自带标记）
					call("/plugin-console/search", { q: query, page: 1, multi: true }).then(
						(data) => {
							setMarket({ status: "ready", data: data.items, direct: false, source: "all", multi: true });
						},
						(error) => setMarket({ status: "error", error: friendlyGithubError(error) }),
					);
					return;
				}
				if (searchSource !== "github") {
					// Gitee / 自定义源：走服务端平台检索（浏览器直连通道对这些平台不可靠）
					call("/plugin-console/search", { q: query, page: 1, source: searchSource }).then(
						(data) => {
							setMarket({ status: "ready", data: data.items, direct: false, source: searchSource });
							enrichOfficialBundle(data.items).then((enriched) => {
								applyEnriched(enriched);
							});
						},
						(error) => setMarket({ status: "error", error: friendlyGithubError(error) }),
					);
					return;
				}
				searchFromGithub(query, 1, repoLandOn).then(
					(data) => {
						// 秒出直连数据
						setMarket({ status: "ready", data, direct: true });
						// 并行补标记：
						// ① 客户端浏览器直连读根包 package.json（快，官方/聚合标记立即可筛）
						enrichOfficialBundle(data).then((enriched) => {
							applyEnriched(enriched);
						});
						// ② 服务端 curl 双通道 enrich（聚合子包 dsh.bundle 检查 → aggregateInstallable），后台补更精确标记
						call("/plugin-console/enrich", { items: data }).then(
							(r) => { if (r && Array.isArray(r.items)) applyEnriched(r.items); },
							() => {},
						);
						// ③ 服务端"增量检索"（并行、不阻塞首屏）：npm 包名映射 + in:readme 重查 + 代码搜索子包。
						// 直连搜索只覆盖 仓库名/描述/topics，包名与 README/文件里的名字补不上（2026-09-20 事故）
						if (query.trim() !== "") {
							call("/plugin-console/search", { q: query, page: 1, extras: true, all: repoLandOn === true }).then(
								(r) => {
									if (r !== null && r.codeSearchSkipped === true) setMessage(t("searchLoginHint"));
									if (r === null || !Array.isArray(r.items) || r.items.length === 0) return;
									setMarket((m) => (m !== null && m.status === "ready" ? { ...m, data: mergeSearchExtras(m.data, r.items) } : m));
								},
								() => {},
							);
						}
					},
					() => call("/plugin-console/search", { q: query, page: 1 }).then(
						(data) => {
							const items = data.items;
							setMarket({ status: "ready", data: items, direct: false });
							enrichOfficialBundle(items).then((enriched) => {
								applyEnriched(enriched);
							});
						},
						(error) => setMarket({ status: "error", error: friendlyGithubError(error) }),
					),
				);
			};
			const loadMore = () => {
				if (loadingMore || market === null || market.status !== "ready") return;
				const next = marketPage + 1;
				setLoadingMore(true);
				setMarketPage(next);
				if (mode === "skills" && !market.fromIndex) {
					// 技能搜索分页：服务端三 topic 合并（skills: true）
					call("/plugin-console/search", { q: query, page: next, skills: true }).then(
						(data) => {
							const merged = [...market.data, ...data.items];
							const seen = new Set();
							const deduped = [];
							for (const item of merged) {
								if (seen.has(item.fullName)) continue;
								seen.add(item.fullName);
								deduped.push(item);
							}
							setMarket({ status: "ready", data: deduped, direct: false, source: "github", skills: true });
							setLoadingMore(false);
						},
						(error) => {
							setLoadingMore(false);
							setMessage(t("failed") + "：" + friendlyGithubError(error).message);
						},
					);
					return;
				}
				if (market.fromIndex === true && indexData !== null) {
					// 索引浏览：本地继续展示更多（技能模式浏览技能索引段）
					const sourceData = mode === "skills" ? indexData.skills : indexData.items;
					const more = sourceData.slice(0, indexShown + next * 50);
					setMarket({ status: "ready", data: more, direct: false, source: "github", fromIndex: true });
					setIndexShown(indexShown + next * 50);
					// 新增的这段继续补「官方/聚合」标记（与首屏同样的增量策略）
					if (mode !== "skills") enrichRange(enrichedUpTo, indexShown + next * 50, indexData.items);
					setLoadingMore(false);
					return;
				}
				if (multiSource) {
					call("/plugin-console/search", { q: query, page: next, multi: true }).then(
						(data) => {
							setMarket({ status: "ready", data: [...market.data, ...data.items], direct: false, source: "all", multi: true });
							setLoadingMore(false);
						},
						(error) => {
							setLoadingMore(false);
							setMessage(t("failed") + "：" + friendlyGithubError(error).message);
						},
					);
					return;
				}
				if (searchSource !== "github") {
					call("/plugin-console/search", { q: query, page: next, source: searchSource }).then(
						(data) => {
							setMarket({ status: "ready", data: [...market.data, ...data.items], direct: false, source: searchSource });
							setLoadingMore(false);
							enrichOfficialBundle(data.items).then((enriched) => {
								setMarket((m) => (m !== null && m.status === "ready"
									? { ...m, data: [...m.data.slice(0, m.data.length - enriched.length), ...enriched] }
									: m));
							});
						},
						(error) => {
							setLoadingMore(false);
							setMessage(t("failed") + "：" + friendlyGithubError(error).message);
						},
					);
					return;
				}
				searchFromGithub(query, next).then(
					(data) => {
						setMarket({ status: "ready", data: [...market.data, ...data], direct: true });
						setLoadingMore(false);
						// 并行补标记：客户端快速（根包）+ 服务端完整（子包检查）
						enrichOfficialBundle(data).then((enriched) => {
							setMarket((m) => (m !== null && m.status === "ready"
								? { ...m, data: [...m.data.slice(0, m.data.length - enriched.length), ...enriched] }
								: m));
						});
						call("/plugin-console/enrich", { items: data }).then(
							(r) => {
								if (r && Array.isArray(r.items)) {
									setMarket((m) => (m !== null && m.status === "ready"
										? { ...m, data: [...m.data.slice(0, m.data.length - r.items.length), ...r.items] }
										: m));
								}
							},
							() => {},
						);
					},
					() => call("/plugin-console/search", { q: query, page: next }).then(
						(data) => {
							setMarket({ status: "ready", data: [...market.data, ...data.items], direct: false });
							setLoadingMore(false);
							enrichOfficialBundle(data.items).then((enriched) => {
								setMarket((m) => (m !== null && m.status === "ready"
									? { ...m, data: [...m.data.slice(0, m.data.length - enriched.length), ...enriched] }
									: m));
							});
						},
						(error) => {
							setLoadingMore(false);
							setMessage(t("failed") + "：" + friendlyGithubError(error).message);
						},
					),
				);
			};
			const loadSubpackages = (repo, branch) => {
				setSubpackages({ status: "loading" });
				fetchSubpackages(repo, branch).then(
					(list) => setSubpackages({ status: "ready", list }),
					() => call("/plugin-console/subpackages", { repo, branch }).then(
						(data) => setSubpackages({ status: "ready", list: data.subpackages ?? [] }),
						() => setSubpackages({ status: "error" }),
					),
				);
			};
			const inspect = (item) => {
				const repo = item.fullName;
				setRepoInfo({ status: "loading", repo });
				setSubpackages(null);
				if (item.source !== undefined && item.source !== "github") {
					// 非 GitHub 平台：用平台 raw 直接读详情（无 trees/子包能力）
					repoInfoFromPlatform(item).then(
						(data) => setRepoInfo({ status: "ready", repo, data, direct: true, source: item.source }),
						() => setRepoInfo({ status: "error", repo, error: new Error(t("repoError")) }),
					);
					return;
				}
				repoInfoFromGithub(repo, item).then(
					(data) => {
						if (item.hasSkill === true) data.hasSkill = true;
						if (Array.isArray(item.skillTopics)) data.skillTopics = item.skillTopics;
						if (item.hasSuite === true) {
							data.hasSuite = true;
							// 立即本地拼官方安装命令（不等服务端后台补拉），手动安装引导即时可见
							if (!data.installCommand) {
								const short = repo.split("/")[1] ?? repo;
								data.installCommand = "git clone --recurse-submodules https://github.com/" + repo + ".git\ncd " + short + "\npowershell -ExecutionPolicy Bypass -File install.ps1";
							}
						}
						setRepoInfo({ status: "ready", repo, data, direct: true });
						if (data.privateRoot || !data.hasPackageJson) loadSubpackages(repo, data.defaultBranch);
						// 浏览器直连只读 package.json/README/SKILL.md：后台补拉服务端增强字段
						// （hasSuite / installCommand 官方安装方式），不阻塞详情显示
						call("/plugin-console/repo", { repo }).then(
							(d) => {
								if (d && d.ok === true) {
									setRepoInfo((prev) => (prev !== null && prev.repo === repo && prev.status === "ready"
										? { ...prev, data: {
											...prev.data,
											hasSuite: d.hasSuite === true,
											installCommand: d.installCommand ?? null,
										} }
										: prev));
								}
							},
							() => {},
						);
					},
					() => call("/plugin-console/repo", { repo }).then(
						(data) => {
							if (item.hasSkill === true) data.hasSkill = true;
							if (Array.isArray(item.skillTopics)) data.skillTopics = item.skillTopics;
							if (item.hasSuite === true) data.hasSuite = true;
							setRepoInfo({ status: "ready", repo, data, direct: false });
							if (data.privateRoot || !data.hasPackageJson) loadSubpackages(repo, data.defaultBranch);
						},
						(error) => setRepoInfo({ status: "error", repo, error: friendlyGithubError(error) }),
					),
				);
			};
			/** 后台安装任务：/install 立即返回 jobId，轮询 /install-status 更新进度。 */
			const jobTimersRef = react.useRef({});
			const stopJobPolling = (jobId) => {
				if (jobTimersRef.current[jobId]) {
					window.clearInterval(jobTimersRef.current[jobId]);
					delete jobTimersRef.current[jobId];
				}
			};
			const pollJob = (jobId) => {
				if (jobTimersRef.current[jobId]) return;
				jobTimersRef.current[jobId] = window.setInterval(() => {
					call("/plugin-console/install-status", { jobId }).then(
						(data) => {
							setJobs((prev) => ({ ...prev, [jobId]: data }));
							// 授权请求必须"看得见"（2026-09-20 真装实测事故：面板只把 stage 变成
							// ai-consent，用户不知道要做什么 → 干等 10 分钟被超时取消）。顶部消息先说一句，
							// 详情卡在下面的安装进度区（同一位置的醒目卡片 + 倒计时 + 同意/取消）。
							if (data.status === "installing" && data.stage === "ai-consent" && data.aiConsent?.pending === true && !aiAutoDeclinedRef.current[jobId]) {
								setMessage(t("aiConsentTopHint"));
							}
							// 需要用户授权时（面板页后台/失焦也能看到）：系统通知 + 标题闪烁提示
							if (data.status === "installing" && data.stage === "ai-consent" && aiFallback && !aiRemember && !aiAutoDeclinedRef.current[jobId]) {
								aiAutoDeclinedRef.current[jobId] = true;
								const who = data.packageName ?? data.repo ?? "";
								try {
									const title = t("aiConsentNotifyTitle");
									if ("Notification" in window && Notification.permission === "granted") {
										new Notification(title, { body: who + "：" + t("aiConsentText").slice(0, 80) + "…", tag: "dsh-ai-consent" });
									} else if ("Notification" in window && Notification.permission === "default") {
										Notification.requestPermission().then((p) => {
											if (p === "granted") new Notification(title, { body: who + "：" + t("aiConsentText").slice(0, 80) + "…", tag: "dsh-ai-consent" });
										});
									}
								} catch {}
								try {
									document.title = "⚠ " + t("aiConsentNotifyTitle") + " - " + who;
								} catch {}
							}
							// AI 兜底已关闭：遇到授权等待态自动取消（零费用，不弹窗）
							if (data.status === "installing" && data.stage === "ai-consent" && !aiFallback && !aiAutoDeclinedRef.current[jobId]) {
								aiAutoDeclinedRef.current[jobId] = true;
								aiConsent(jobId, false);
							}
							// 用户勾选"不再提醒"：自动同意 AI 兜底（已预先授权，可能产生费用）
							if (data.status === "installing" && data.stage === "ai-consent" && aiFallback && aiRemember && !aiAutoDeclinedRef.current[jobId]) {
								aiAutoDeclinedRef.current[jobId] = true;
								aiConsent(jobId, true);
							}
							if (data.status !== "installing") {
								stopJobPolling(jobId);
								if (data.status === "done") {
									if (data.kind === "skill") {
										// 技能安装：不写补丁、无需重启/刷新页面；提示 + 刷新已装技能清单
										setMessage(t("skillInstalledMsg") + "：" + (data.skillName ?? "") + "。" + (data.skillNote ?? t("skillInstallNote")));
										call("/plugin-console/skills-installed").then(
											(d) => { if (d && Array.isArray(d.skills)) setInstalledSkills(d.skills); },
											() => {},
										);
									} else if (data.kind === "suite") {
										// 套装安装：保存组件报告；有 bundle 组件需重启，否则刷新页面
										if (Array.isArray(data.suiteReport)) setSuiteReports((prev) => ({ ...prev, [jobId]: data.suiteReport }));
										setMessage(t("suiteInstalledMsg") + "：" + (data.suiteNote ?? ""));
										if ((data.suiteReport ?? []).some((r) => r.type === "bundle" && r.ok)) {
											setRestartHint(true);
										} else {
											setReloadHint(true);
											window.setTimeout(() => window.location.reload(), 2500);
										}
									} else if (data.ai === true) {
										setMessage(t("installed") + "：" + data.packageName + "。" + (data.aiNote ?? t("aiRepaired")));
									} else {
										setMessage(t("installed") + "：" + data.packageName + "（" + (data.entryId ?? "") + "）。" + (data.curlNote ?? (data.bundle ? t("bundleNote") : t("installNote"))) + (data.bundleNote ? "。" + data.bundleNote : "") + (data.lockNote ? "。⚠️ " + data.lockNote : "") + (data.depNote ? "。" + data.depNote : ""));
									}
									if (data.kind === "skill") {
										// 技能无需页面刷新
										setInstalling(null);
										setTimeout(refresh, 500);
										return;
									}
									if (data.bundle) {
										setRestartHint(true);
									} else {
										// 安装成功：自动刷新页面，让插件立即出现在列表里（可见的成功反馈）
										setReloadHint(true);
										window.setTimeout(() => window.location.reload(), 2500);
									}
								} else {
									setMessage(t("failed") + "：" + (data.error ?? "未知错误"));
								}
								setInstalling(null);
								setTimeout(refresh, 1500);
							}
						},
						() => {},
					);
				}, 2000);
			};
			/** 本地 AI 兜底授权：调用模型 API 产生费用，必须用户明确同意。 */
			const aiConsent = (jobId, approved) => {
				call("/plugin-console/ai-consent", { jobId, approved }).then(
					() => { if (!approved) setMessage(t("failed") + "：已取消本地 AI 兜底（不会调用模型 API）"); },
					(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
				);
			};
			/** 安装进度文案：服务端 progress{channel,phase,index,total,name,done} → 一行人话。
			 * 2026-09-20 真装实测：11 个子包的聚合仓库跑 19 分钟，面板只有"安装中"——用户不知道
			 * 在第几个、还剩几个、当前装的是谁。这里把服务端下发的进度翻成"第 i/n 个：<名字>"。 */
			const progressText = (progress) => {
				if (progress === null || progress === undefined) return "";
				if (progress.done === true) return t("progressDone").replace("{total}", String(progress.total ?? 0));
				const key = progress.channel === "suite"
					? (progress.phase === "clone" ? "progressSuiteClone" : "progressSuiteAssemble")
					: "progressSubpackage";
				return t(key)
					.replace("{index}", String(progress.index ?? 0))
					.replace("{total}", String(progress.total ?? 0))
					.replace("{name}", progress.name ?? "");
			};
			/** 授权倒计时（剩余 mm:ss）：服务端只给请求时间 + 超时上限，剩余量在前端算。
			 * 轮询每 2s 触发一次重渲染，倒计时随之刷新，不需要额外的定时器。 */
			const consentRemaining = (job) => {
				const consent = job?.aiConsent ?? null;
				if (consent === null || consent.pending !== true || typeof consent.since !== "number") return null;
				const timeoutMs = typeof consent.timeoutMs === "number" && consent.timeoutMs > 0 ? consent.timeoutMs : 600000;
				const left = Math.max(0, Math.round((consent.since + timeoutMs - Date.now()) / 1000));
				return Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
			};
			const consentTimeoutMinutes = (job) => {
				const timeoutMs = job?.aiConsent?.timeoutMs;
				return String(Math.max(1, Math.round((typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 600000) / 60000)));
			};
			/** 软件源管理：打开时拉取当前配置。 */
			const openSources = () => {
				setSourcesOpen(true);
				call("/plugin-console/sources").then(
					(data) => {
						setSourcesData(data.sources);
						setSearchSourcesList(data.sources.searchSources ?? []);
						setGiteeClientId(data.sources.gitee?.clientId ?? "");
						// 安全：secret 永不回传（服务端已脱敏）；已配置时留空、保存需重新输入，
						// 未配置时为空表单引导首次填写
						setGiteeClientSecret("");
					},
					(error) => { setSourcesOpen(false); setMessage(t("failed") + "：" + friendlyGithubError(error).message); },
				);
			};
			const saveGiteeSetup = () => {
				// clientId 打码回显（如 abc12345…）：用户未修改时原样传回服务端，服务端识别打码标记保留原配置
				const idValue = giteeClientId.trim();
				if (!idValue || !giteeClientSecret.trim()) {
					setMessage(t("failed") + "：client_id / client_secret 不能为空");
					return;
				}
				if (idValue.endsWith("…")) {
					sourcesAction({ action: "gitee-setup", clientId: "", clientSecret: giteeClientSecret.trim(), keepClientId: true });
				} else {
					sourcesAction({ action: "gitee-setup", clientId: idValue, clientSecret: giteeClientSecret.trim() });
				}
			};
			const startGiteeOauth = () => {
				call("/plugin-console/gitee-oauth-url").then(
					(data) => { if (data && data.url) window.open(data.url, "_blank", "noopener"); },
					(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
				);
			};
			const sourcesAction = (payload, done) => {
				setSourcesBusy(true);
				call("/plugin-console/sources", payload).then(
					(data) => {
						setSourcesData(data.sources);
						setSearchSourcesList(data.sources.searchSources ?? []);
						setMessage(t("sourcesUpdated"));
						if (done) done();
					},
					(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
				).finally(() => setSourcesBusy(false));
			};
			const addSource = () => {
				if (!isAllowedSourceUrl(sourceUrl.trim())) {
					setMessage(t("failed") + "：" + t("invalidSourceUrl"));
					return;
				}
				sourcesAction({ action: "add", name: sourceName.trim(), url: sourceUrl.trim() }, () => { setSourceName(""); setSourceUrl(""); });
			};
			/** 软件源扫描：服务端并发探测每个源（可达性/延迟/最新版本），结果显示在源列表行内。 */
			const scanRegistries = () => {
				setRegScan({ status: "scanning" });
				call("/plugin-console/registry-scan", {}).then(
					(data) => setRegScan({ status: "ready", results: Array.isArray(data.results) ? data.results : [], scannedAt: typeof data.scannedAt === "number" ? data.scannedAt : null }),
					(error) => { setRegScan(null); setMessage(t("failed") + "：" + friendlyGithubError(error).message); },
				);
			};
			// 扫描结果派生视图：每条源的命中结果 + 可达计数 + 最新版本来自哪个源
			const scanRows = regScan !== null && regScan.status === "ready" ? regScan.results : [];
			const scanOf = (id) => scanRows.find((row) => row.id === id) ?? null;
			const scanOkCount = scanRows.filter((row) => row.ok === true).length;
			const scanBest = (() => {
				const withVersion = scanRows.filter((row) => row.ok === true && typeof row.latest === "string");
				if (withVersion.length === 0) return null;
				const parse = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
				const newer = (a, b) => {
					const [pa, pb] = [parse(a), parse(b)];
					for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i];
					return false;
				};
				return withVersion.reduce((best, row) => (best === null || newer(row.latest, best.latest) ? row : best), null);
			})();
			const saveEditReg = () => {
				if (editReg === null) return;
				sourcesAction({ action: "edit", id: editReg.id, name: editReg.name, url: editReg.url }, () => setEditReg(null));
			};
			const addIndexSource = () => {
				if (!isAllowedSourceUrl(indexSourceUrl.trim())) {
					setMessage(t("failed") + "：" + t("invalidSourceUrl"));
					return;
				}
				sourcesAction({ action: "add-index", name: indexSourceName.trim(), url: indexSourceUrl.trim() }, () => { setIndexSourceName(""); setIndexSourceUrl(""); });
			};
			const saveEditIndex = () => {
				if (editIndex === null) return;
				sourcesAction({ action: "edit-index", id: editIndex.id, name: editIndex.name, url: editIndex.url }, () => setEditIndex(null));
			};
			const addGitSource = () => {
				const tpl = gitSourceUrl.trim();
				if (!tpl.includes("{owner}") || !tpl.includes("{repo}")) {
					setMessage(t("failed") + "：" + t("gitUrlPlaceholder"));
					return;
				}
				if (!isAllowedSourceUrl(tpl)) {
					setMessage(t("failed") + "：" + t("invalidSourceUrl"));
					return;
				}
				sourcesAction({ action: "add-git", name: gitSourceName.trim(), urlTemplate: tpl }, () => { setGitSourceName(""); setGitSourceUrl(""); });
			};
			const saveEditGit = () => {
				if (editGit === null) return;
				sourcesAction({ action: "edit-git", id: editGit.id, name: editGit.name, urlTemplate: editGit.urlTemplate }, () => setEditGit(null));
			};
			/** 折叠分区（软件源弹窗）：标题可点，展开/收起各自独立；软件源默认展开。 */
			const accSection = (key, title, children) => {
				const open = openSections[key] === true;
				return el("div", { key, className: styles.acc },
					el("button", {
						type: "button",
						className: styles.accHead,
						"data-open": open ? "true" : "false",
						"aria-expanded": open ? "true" : "false",
						onClick: () => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] })),
					}, (open ? "▾ " : "▸ ") + title),
					open ? el("div", { className: styles.accBody }, ...children) : null);
			};
			const addSearchSource = () => {
				if (!isAllowedSourceUrl(searchSourceUrl.trim()) || !searchSourceUrl.includes("{q}")) {
					setMessage(t("failed") + "：" + t("invalidSearchUrl"));
					return;
				}
				// 解析请求头：每行 "名称: 值"
				const headers = searchSourceHeaders.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "")
					.map((line) => {
						const idx = line.indexOf(":");
						if (idx <= 0) return null;
						return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
					})
					.filter((h) => h !== null);
				sourcesAction(
					{ action: "add-search", name: searchSourceName.trim(), url: searchSourceUrl.trim(), headers },
					() => { setSearchSourceName(""); setSearchSourceUrl(""); setSearchSourceHeaders(""); },
				);
			};
			const startJob = (repo, packageName, source = "github", kind = "plugin", update = false) => {
				// 防并发（与 addLocal 一致）：已有安装/更新进行中时忽略新点击（更新按钮此前可绕过，
				// 反复点击会产生几十个并发任务装同一插件）
				if (installing !== null) {
					setMessage(t("installBusy"));
					return;
				}
				setInstalling(repo || packageName);
				setReloadHint(false);
				setRestartHint(false);
				setMessage(null);
				call("/plugin-console/install", { repo: repo ?? "", packageName, source, kind, update }).then(
					(data) => {
						if (data && data.jobId) {
							setJobs((prev) => ({
								...prev,
								[data.jobId]: { jobId: data.jobId, repo, source, packageName, kind, status: "installing", stage: "preparing", startedAt: Date.now() },
							}));
							pollJob(data.jobId);
						}
					},
					(error) => {
						setMessage(t("failed") + "：" + friendlyGithubError(error).message);
						setInstalling(null);
					},
				);
			};
			/** 技能安装：git clone 仓库 → 复制 SKILL.md 到 ~/.dsh/skills/<name>/（不写 cordis 补丁、无需重启）。 */
			const startSkillJob = (item) => {
				if (installing !== null) return;
				startJob(item.fullName, null, item.source ?? "github", "skill");
			};
			/** 套装安装：submodule 聚合仓库（照 install.ps1 语义装配子模块组件）。 */
			const startSuiteJob = (item) => {
				if (installing !== null) return;
				startJob(item.fullName, null, item.source ?? "github", "suite");
			};
			// 卸载时清理轮询定时器；页面回到前台时恢复标题（AI 授权提示后）
			react.useEffect(() => {
				const onVisible = () => {
					if (document.visibilityState === "visible") {
						try { document.title = originalTitleRef.current; } catch {}
					}
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					document.removeEventListener("visibilitychange", onVisible);
					for (const timer of Object.values(jobTimersRef.current)) window.clearInterval(timer);
				};
			}, []);
			/** 搜索结果卡片上的"添加到本地"：直接启动安装任务（服务端解析包名与类型），
			 * 点击立即出现进度卡片——不再先浏览器取包名（黑洞期直连失败会拖到 40s 无反馈）。
			 * 技能条目走技能通道，套装条目走套装通道。 */
			const addLocal = (item) => {
				if (installing !== null) return;
				setInstalling(item.fullName);
				setMessage(null);
				if (item.fullName === "deepseek-ai/deepseek-harness") {
					// 框架本体：不提供安装（服务端也会拦截）；升级请用卡片「框架升级」流程
					setMessage(t("frameworkUseUpgrade"));
					setInstalling(null);
					return;
				}
				if (item.hasSkill === true || item.skillTopics !== undefined) {
					// 没有 npm 包但有 SKILL.md：按技能安装（clone → ~/.dsh/skills）
					startSkillJob(item);
					return;
				}
				if (item.hasSuite === true) {
					// submodule 聚合套装：走套装安装通道（clone → 子模块按类型装配）
					startSuiteJob(item);
					return;
				}
				if ((item.subpackagePath || item.npmPackage === true) && typeof item.packageName === "string" && item.packageName !== "") {
					// monorepo 子包：搜索结果带 packageName，按 npm 包名安装
					startJob(item.fullName, item.packageName, item.source ?? "github");
					return;
				}
				startJob(item.fullName, null, item.source ?? "github");
			};
			/** 停用/启用已安装技能（写入官方调用策略 frontmatter，可逆）。 */
			const doToggleSkill = (name, enabled) => {
				setTogglingSkill(name);
				call("/plugin-console/skill-toggle", { name, enabled }).then(
					() => {
						setMessage((enabled ? t("skillEnabledMsg") : t("skillToggledMsg")) + "：" + name);
						setConfirmSkillDelete(null);
						setTogglingSkill(null);
						setInstalledSkills((prev) => prev.map((s) => (s.name === name ? { ...s, disabled: !enabled } : s)));
					},
					(error) => {
						setTogglingSkill(null);
						setMessage(t("failed") + "：" + friendlyGithubError(error).message);
					},
				);
			};
			/** 复制安装命令到剪贴板（navigator.clipboard + 兼容兜底）。 */
			const copyInstallCommand = (cmd) => {
				const done = () => setMessage(t("copiedInstallCmd"));
				const fallback = () => {
					try {
						const ta = document.createElement("textarea");
						ta.value = cmd;
						ta.style.position = "fixed";
						ta.style.opacity = "0";
						document.body.appendChild(ta);
						ta.select();
						const ok = document.execCommand("copy");
						document.body.removeChild(ta);
						if (ok) done();
					} catch {}
				};
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(cmd).then(done, fallback);
					} else fallback();
				} catch { fallback(); }
			};
			/** 框架升级：Hub 打包备份现有配置 + 版本检测 + 升级脚本（脚本会自行停止/拉起服务，无需手动重启）。 */
			const doFrameworkUpgrade = () => {
				setFrameworkUpgrading(true);
				call("/plugin-console/framework-upgrade", {}).then(
					(data) => {
						setFrameworkUpgrading(false);
						setConfirmFrameworkUpgrade(false);
						if (data && data.ok === true) {
							// 新一轮升级开始：让卡片恢复显示（清掉"本次会话隐藏"，运行身份由时间戳自然区分）
							setFwStatusDismissed(false);
							setMessage(t("frameworkUpgradeDone")
								+ (data.hasUpdate === true ? "：" + (data.current ?? "?") + " → " + (data.target ?? data.latest ?? "?") : (data.registryError ? t("frameworkUpgradeCheckFailed") : t("frameworkUpgradeUpToDate")))
								+ "。备份：" + (data.backupDir ?? "") + "。" + (Array.isArray(data.hints) ? data.hints.join(" ") : ""));
							// 升级脚本会自行停止→升级→拉起服务：不显示手动重启按钮（避免升级中途被干扰）
							setRestartHint(false);
							setReloadHint(false);
							// 启动进度条轮询（服务断开前能看到前几步；重连后自动恢复）
							setFrameworkStatus({ status: "starting", message: t("fwStepBackup") });
							pollFrameworkStatus();
						}
					},
					(error) => {
						setFrameworkUpgrading(false);
						setConfirmFrameworkUpgrade(false);
						setMessage(t("failed") + "：" + friendlyGithubError(error).message);
					},
				);
			};
			/** 删除已安装技能（~/.dsh/skills/<name> 目录），两步确认防误删。 */
			const doRemoveSkill = (name) => {
				call("/plugin-console/skill-remove", { name }).then(
					() => {
						setMessage(t("skillDeletedMsg") + "：" + name);
						setConfirmSkillDelete(null);
						setInstalledSkills((prev) => prev.filter((s) => s.name !== name));
					},
					(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
				);
			};
			const installedQueryNorm = installedQuery.trim().toLowerCase();
			// 当前搜索源的展示名（内置 + 自定义）
			const sourceDisplayName = (source) => source === "github"
				? "GitHub"
				: source === "gitee"
					? "Gitee"
					: ((searchSourcesList !== null ? searchSourcesList.find((s) => s.id === source)?.name : undefined) ?? source);
			// 仓库落地提示：动态带上当前主 Git 源名称（Git 源可自定义，不能写死 GitHub）
			const repoLandTitleText = () => {
				const primary = (gitSourcesList ?? []).find((s) => s.primary === true);
				const label = primary?.name ?? t("repoLandSourceUnknown");
				return t("repoLandTitle").replace("{source}", label);
			};
			const extraIds = new Set((state.status === "ready" ? state.data.patch?.inserts ?? [] : []));
			const extraCount = state.status === "ready" ? state.data.entries.filter((entry) => entry.extra === true || extraIds.has(entry.rowId)).length : 0;
			const pkgRootOf = (m) => { const mm = String(m ?? ""); const x = mm.match(/^(@[^/]+\/[^/]+)(?:\/.*)?$/u); return x ? x[1] : mm; };
			const filteredEntries = state.status === "ready"
				? state.data.entries.filter((entry) => {
					if (extraOnly && !(entry.extra === true || extraIds.has(entry.rowId))) return false;
					if (installedQueryNorm === "") return true;
					return [entry.moduleName, entry.entryId, entry.rowId]
						.some((value) => String(value ?? "").toLowerCase().includes(installedQueryNorm));
				})
				: [];
			// 聚合包分组：仅「同根包 + 子路径导出」（web-all 0.3.14 式，moduleName=pkg/sub）→ 全家桶组；
			// 经典多子包聚合（每子包独立名）不归组。组头与子包卡片一律置于列表【最底部】。
			const famRootOf = (entry) => {
				const m = String(entry.moduleName ?? "");
				if (m.startsWith("@deepseek-ai/")) return null;
				return pkgRootOf(m);
			};
			const familyCounts = new Map(); // root → Set(moduleName)：仅按不同子包名聚合；同一包的重复行不算全家桶（2026-09-06 i18n 重复行事故）
			for (const entry of (state.status === "ready" ? state.data.entries : [])) {
				const root = famRootOf(entry);
				if (root === null) continue;
				const set = familyCounts.get(root) ?? new Set();
				set.add(String(entry.moduleName ?? ""));
				familyCounts.set(root, set);
			}
			const familySize = (root) => (familyCounts.get(root)?.size ?? 0);
			const familyCards = filteredEntries.map((entry) => {
					const familyRoot = String(entry.moduleName ?? "").startsWith("@deepseek-ai/") ? null : pkgRootOf(entry.moduleName);
					void familyRoot;
					const open = details !== null && details.entryId === entry.entryId;
					let detailPanel = null;
					if (open) {
						if (details.status === "loading") {
							detailPanel = el("div", { className: styles.detail },
								el("p", { className: styles.status }, t("loadingDetails")));
						} else if (details.status === "error") {
							detailPanel = el("div", { className: styles.detail },
								el("p", { className: styles.status, "data-error": "true" }, t("failed") + "：" + details.error.message));
						} else {
							const meta = details.data.meta;
							const readme = details.data.readme;
							const compatInfo = state.status === "ready" && state.data.compatPending
								? (state.data.compatPending.pending ?? []).find((p) => p.rowId === entry.rowId) ?? null
								: null;
							detailPanel = el("div", { className: styles.detail },
								meta !== null ? el("p", { className: styles.desc }, meta.description ?? t("noDetail")) : null,
								entry.pendingCompat === true
									? el("p", { className: styles.status, "data-pending": entry.adoptable ? "false" : "true" },
										entry.adoptable
											? t("adoptableDetected").replace("{version}", String(entry.adoptable.version ?? "?")).replace("{prev}", String(compatInfo?.version ?? "?"))
											: t("pendingCompatHint") + (compatInfo && compatInfo.checkNote ? "；已知校验：" + compatInfo.checkNote : ""))
									: null,
								meta !== null && meta.version ? el("div", { className: styles.rowTop },
									el("p", { className: styles.status }, t("versionLabel") + "：" + meta.version),
									el("button", {
										type: "button",
										className: styles.toggle,
										disabled: (updateCheck !== null && updateCheck.status === "checking") || installing === entry.moduleName,
										onClick: () => checkUpdate(entry),
									}, updateCheck !== null && updateCheck.status === "checking" ? t("checkingUpdate") : t("checkUpdate")),
									el("button", {
										type: "button",
										className: styles.toggle,
										title: t("aiEmpowerTitle"),
										onClick: () => openAiFor(String(entry.moduleName ?? entry.repo ?? "")),
									}, t("aiEmpowerLabel")),
									entry.pendingCompat === true
										? el("button", {
											type: "button",
											className: styles.toggle,
											"data-pending": "true",
											title: t("adaptUnlockHint"),
											disabled: installing === entry.moduleName || adaptUnlocking === entry.entryId,
											onClick: () => {
												setAdaptUnlocking(entry.entryId);
												call("/plugin-console/adapt-unlock", { rowId: entry.rowId }).then(
													() => {
														setAdaptUnlocking(null);
														setMessage(t("adaptUnlockDone"));
														window.setTimeout(() => window.location.reload(), 1200);
													},
													(error) => { setAdaptUnlocking(null); setMessage(t("failed") + "：" + friendlyGithubError(error).message); },
												);
											},
										}, adaptUnlocking === entry.entryId ? t("loadingPhase") : t("adaptUnlockBtn"))
										: null) : null,
								updateCheck !== null && updateCheck.status === "ready" && updateCheck.migrate && updateCheck.migrate.compatible
									? el("div", null,
										el("div", { className: styles.rowTop },
											el("p", { className: styles.status }, t("migrateTip") + "：" + String(updateCheck.migrate.to ?? "") + (updateCheck.migrate.latest ? " v" + updateCheck.migrate.latest : "")),
											el("button", {
												type: "button",
												className: styles.toggle,
												disabled: installing === entry.moduleName,
												onClick: () => startJob("", updateCheck.migrate.to, "github", "plugin", false),
											}, installing === entry.moduleName ? t("installing") : t("migrateBtn"))))
									: null,
								updateCheck !== null && updateCheck.status === "ready"
									? (updateCheck.error
										? el("p", { className: styles.status, "data-error": "true" }, t("updateCheckFailed") + "：" + updateCheck.error)
										: (updateCheck.latest && meta !== null && meta.version && updateCheck.latest !== meta.version
											? el("div", null,
												el("div", { className: styles.rowTop },
													el("p", { className: styles.status }, t("updateAvailable") + "：" + meta.version + " → " + updateCheck.latest + (updateCheck.source === "github" ? "（GitHub release）" : "")),
													el("button", {
														type: "button",
														className: styles.toggle,
														disabled: installing === entry.moduleName,
														onClick: () => startJob("", entry.moduleName, "github", "plugin", true),
													}, installing === entry.moduleName ? t("installing") : (entry.pendingCompat === true ? t("updateAndAdapt") : t("updateNow")))),
												Array.isArray(updateCheck.depsOutdated) && updateCheck.depsOutdated.length > 0
													? el("p", { className: styles.status, "data-error": "true" },
														t("depsOutdatedHint") + "：" + updateCheck.depsOutdated.map((d) => `${d.name} ${d.current}→${d.required}`).join("、"))
													: null)
											: el("p", { className: styles.status }, t("upToDate") + (updateCheck.source === "github" ? "（GitHub release 检测）" : ""))))
									: null,
								meta !== null && meta.repository
									? el("p", { className: styles.status }, t("repoLabel") + "：" + String(meta.repository).replace(/^git\+/u, ""))
									: null,
								meta !== null && meta.homepage
									? el("p", { className: styles.status }, t("homepageLabel") + "：" + meta.homepage)
									: null,
								readme !== null && (readme.title || readme.summary)
									? el("div", null,
										el("p", { className: styles.status }, t("readmeLabel") + "："),
										readme.title ? el("strong", null, readme.title + "。") : null,
										readme.summary ? el("p", { className: styles.desc }, readme.summary) : null,
									)
									: meta === null ? el("p", { className: styles.status }, t("noDetail")) : null,
							);
						}
					}
					return el("li", { key: entry.entryId, className: styles.row },
						el("div", { className: styles.rowTop },
							el("strong", { className: styles.name, title: entry.moduleName }, (() => {
								const famRoot = famRootOf(entry);
								const mn = String(entry.moduleName ?? "");
								return famRoot !== null && familySize(famRoot) > 1 && mn.startsWith(famRoot + "/")
									? mn.slice(famRoot.length + 1)
									: moduleShortName(entry.moduleName);
							})()),
							el("span", { className: styles.tag, "data-enabled": entry.enabled ? "true" : "false" },
								t(entry.enabled ? "enabledTag" : "disabledTag")),
							entry.extra === true ? el("span", { className: styles.tag, "data-user": "true" }, t("extraTag")) : null,
							entry.protected ? el("span", { className: styles.tag, "data-user": "true" }, t("protectedTag")) : null,
							entry.userDisabled ? el("span", { className: styles.tag, "data-user": "true" }, t("userDisabledTag")) : null,
							entry.userForced ? el("span", { className: styles.tag, "data-user": "true" }, t("userForcedTag")) : null,
						),
						el("div", { className: styles.meta },
							el("span", { className: styles.phase, "data-phase": entry.fiberPhase ?? "unobserved" },
								phaseLabel(entry.fiberPhase, t)),
							el("code", null, entry.entryId),
						),
						el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
							el("div", { className: styles.rowTop },
								el("button", {
									type: "button",
									className: styles.toggle,
									disabled: !entry.toggleable || busy === entry.entryId || entry.pendingCompat === true,
									title: entry.pendingCompat === true ? t("pendingCompatHint") : undefined,
									onClick: () => toggle(entry, !entry.enabled),
								}, busy === entry.entryId ? t("loadingPhase") : (entry.pendingCompat === true ? t("pendingCompatTag") : t(entry.enabled ? "off" : "on"))),
								el("button", {
									type: "button",
									className: styles.toggle,
									onClick: () => loadDetails(entry),
								}, t("details")),
							),
							el("div", { className: styles.rowTop },
								entry.extra === true && entry.rowId !== "plugin-console"
									? el("button", {
										type: "button",
										className: styles.trashBtn,
										title: t("deletePlugin"),
										"aria-label": t("deletePlugin"),
										disabled: deleteBusy === entry.entryId,
										onClick: () => {
											if (confirmDeleteRowId === entry.entryId) {
												setDeleteBusy(entry.entryId);
												call("/plugin-console/uninstall", { entryId: entry.entryId }).then(
													(data) => {
														setConfirmDeleteRowId(null);
														if (data && data.restart === true) {
															setMessage(t("deleteBundleNote") + "：" + (data.packageName ?? "") + (data.uninstallError ? "（包卸载警告：" + data.uninstallError + "）" : ""));
															setRestartHint(true);
														} else {
															setMessage(t("deleteNote") + "：" + (data.packageName ?? "") + (data.note ? "；" + data.note : "") + (data.uninstallError ? "（包卸载警告：" + data.uninstallError + "）" : ""));
															setTimeout(refresh, 1500);
														}
													},
													(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
												).finally(() => setDeleteBusy(null));
											} else {
												setConfirmDeleteRowId(entry.entryId);
												window.setTimeout(() => setConfirmDeleteRowId((v) => (v === entry.entryId ? null : v)), 3000);
											}
										},
									}, deleteBusy === entry.entryId
										? t("deleting")
										: confirmDeleteRowId === entry.entryId
											? t("confirmDelete")
											: el("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
												el("polyline", { points: "3 6 5 6 21 6" }),
												el("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
												el("line", { x1: "10", y1: "11", x2: "10", y2: "17" }),
												el("line", { x1: "14", y1: "11", x2: "14", y2: "17" })))
									: null,
								entry.extra === true && entry.installDate
									? el("span", { className: styles.date }, entry.installDate)
									: null,
							),
						),
						detailPanel,
					);
				});
			// 全家桶组头：聚合包（同根包 ≥2 行）合并展示为一个「web 包」卡片
			const familyHeaders = [];
			const familySeen = new Set();
			for (const entry of filteredEntries) {
				const root = famRootOf(entry);
				if (root === null || familySize(root) <= 1 || familySeen.has(root)) continue;
				familySeen.add(root);
				familyHeaders.push(el("div", { key: "family-" + root, className: styles.detail, style: { border: "1px solid var(--dsw-alias-state-business-primary)", borderRadius: 10, padding: "8px 12px", gridColumn: "1 / -1" } },
					el("div", { className: styles.rowTop, style: { alignItems: "center" } },
						el("strong", { className: styles.name, style: { flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: root }, root.replace(/^@[^/]+\//u, "").replace(/^dsh-/u, "")),
						el("span", { className: styles.tag, "data-user": "true" }, t("familyTag") + " · " + familySize(root) + " " + t("familySubs")),
						el("button", {
							type: "button",
							className: styles.toggle,
							style: { whiteSpace: "nowrap", flexShrink: 0 },
							onClick: () => setFamilyCollapsed((prev) => ({ ...prev, [root]: prev[root] !== true })),
						}, familyCollapsed[root] === true ? "▸ " + t("familyExpand") : "▾ " + t("familyCollapse")),
						el("button", {
							type: "button",
							className: styles.toggle,
							style: { whiteSpace: "nowrap", flexShrink: 0 },
							onClick: () => {
								setMessage(t("checkingUpdate"));
								call("/plugin-console/check-update", { packageName: root }).then(
									(d) => {
										const installed = state.status === "ready"
											? (state.data.entries.find((e) => e.moduleName === root) ?? {}).version ?? null
											: null;
										setFamilyCheck((prev) => ({ ...prev, [root]: { latest: d?.latest ?? null, installed } }));
										setMessage(t("familyUpdate") + "：" + root + " " + (d?.latest ?? "?") + (d?.migrate && d.migrate.compatible ? " → " + d.migrate.to + " v" + d.migrate.latest : "") + (d?.error ? "（" + d.error + "）" : ""));
									},
									(e) => setMessage(t("failed") + "：" + friendlyGithubError(e).message),
								);
							},
						}, t("familyCheckUpdate")),
						familyCheck[root] && familyCheck[root].latest !== null && familyCheck[root].latest !== familyCheck[root].installed
							? el("button", {
								type: "button",
								className: styles.toggle,
								style: { whiteSpace: "nowrap", flexShrink: 0 },
								title: t("familyCheckUpdateTip"),
								onClick: () => startJob("", root, "github", "plugin", true),
							}, t("familyUpdateBtn") + " " + familyCheck[root].latest)
							: null,
						el("button", {
							type: "button",
							className: styles.toggle,
							style: { whiteSpace: "nowrap", flexShrink: 0 },
							title: t("familyUnlockAllTip"),
							onClick: () => {
								if (!window.confirm(t("familyUnlockAllConfirm"))) return;
								call("/plugin-console/adapt-unlock-all", { root }).then(
									(d) => {
										const unlockedCount = (d?.unlocked ?? []).length;
										if (unlockedCount === 0 && typeof d?.note === "string") { setMessage(d.note); return; }
										setMessage(t("familyUnlockAllDone") + "：" + unlockedCount + " 行" + (Array.isArray(d?.kept) && d.kept.length > 0 ? "；保留 " + d.kept.length + " 行（未通过校验）" : ""));
										window.setTimeout(() => window.location.reload(), 1500);
									},
									(e) => setMessage(t("failed") + "：" + friendlyGithubError(e).message),
								);
							},
						}, t("familyUnlockAll")))
				));
			}
			// 组头放到最底部：普通条目在前，全家桶（组头+子包卡片）整体在后
			const nonFamilyCards = [];
			const familySections = new Map();
			familyCards.forEach((card, i) => {
				const e = filteredEntries[i];
				if (e === undefined) { nonFamilyCards.push(card); return; }
				const root = famRootOf(e);
				if (root === null || familySize(root) <= 1) { nonFamilyCards.push(card); return; }
				if (!familySections.has(root)) familySections.set(root, { head: familyHeaders.find((h) => h && h.key === "family-" + root) ?? null, cards: [] });
				familySections.get(root).cards.push(card);
			});
			const familySectionEls = [];
			for (const [, section] of familySections) {
				if (section.head !== null) familySectionEls.push(section.head);
				const root = section.head !== null ? section.head.key.slice("family-".length) : null;
				if (root === null || familyCollapsed[root] !== true) familySectionEls.push(...section.cards);
			}
			// 已安装但尚未生效（bundle 型要重启才被加载；对应服务端 /state 的 pendingRestart）：
			// 演练实测（2026-09-20）装完这类插件时 entryId 为 null、loader 里也没有新条目 ——
			// 用户以为没装上，删除按钮也无处可点。这里渲染成同样的行 + 「已安装·重启后生效」徽标，
			// 行上的删除按钮按 jobId 撤销这次安装（服务端删补丁行 / bundles 清单 / 包目录）。
			const pendingCards = (state.status === "ready" ? state.data.pendingRestart ?? [] : [])
				.filter((job) => installedQueryNorm === "" || [job.packageName, job.repo, job.jobId]
					.some((value) => String(value ?? "").toLowerCase().includes(installedQueryNorm)))
				.map((job) => el("li", { key: "pending-" + job.jobId, className: styles.row },
					el("div", { className: styles.rowTop },
						el("strong", { className: styles.name, title: job.packageName }, job.packageName),
						el("span", { className: styles.tag, "data-pending": "true", title: t("pendingRestartHint") }, t("pendingRestartTag")),
					),
					el("div", { className: styles.meta },
						el("code", null, job.jobId),
						job.repo ? el("code", null, job.repo) : null,
					),
					el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
						el("p", { className: styles.desc }, t("pendingRestartHint")),
						el("div", { className: styles.rowTop },
							el("button", {
								type: "button",
								className: styles.trashBtn,
								title: t("pendingRestartDelete"),
								"aria-label": t("pendingRestartDelete"),
								disabled: deleteBusy === job.jobId,
								onClick: () => {
									if (confirmDeleteRowId === job.jobId) {
										setDeleteBusy(job.jobId);
										call("/plugin-console/uninstall", { jobId: job.jobId }).then(
											(data) => {
												setConfirmDeleteRowId(null);
												setMessage(data && data.warn
													? t("pendingRestartPartial") + "：" + data.warn
													: t("pendingRestartNote") + "：" + (data?.packageName ?? "") + (data?.uninstallError ? "（包卸载警告：" + data.uninstallError + "）" : ""));
												refresh();
											},
											(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
										).finally(() => setDeleteBusy(null));
									} else {
										setConfirmDeleteRowId(job.jobId);
										window.setTimeout(() => setConfirmDeleteRowId((v) => (v === job.jobId ? null : v)), 3000);
									}
								},
							}, deleteBusy === job.jobId
								? t("deleting")
								: confirmDeleteRowId === job.jobId
									? t("confirmDelete")
									: el("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
										el("polyline", { points: "3 6 5 6 21 6" }),
										el("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
										el("line", { x1: "10", y1: "11", x2: "10", y2: "17" }),
										el("line", { x1: "14", y1: "11", x2: "14", y2: "17" }))),
						),
					),
				));
			const rows = state.status === "ready" ? [...nonFamilyCards, ...familySectionEls, ...pendingCards] : [];
			const marketShown = market === null || market.status !== "ready"
				? []
				: officialOnly
					? market.data.filter((item) => item.official === true || item.aggregateInstallable === true)
					: market.data;
			const marketRows = market === null ? [] : market.status === "loading"
				? [el("p", { key: "m", className: styles.status }, searchSource === "github" ? t("marketLoading") : t("marketLoadingOther").replace("{source}", sourceDisplayName(searchSource)))]
				: market.status === "error"
					? [el("div", { key: "m", className: styles.detail },
						el("p", { className: styles.status, "data-error": "true" }, t("marketError") + "：" + market.error.message),
						el("button", { type: "button", className: styles.toggle, onClick: search }, t("retry")))]
					: market.data.length === 0
						? [el("p", { key: "m", className: styles.status }, searchSource === "gitee" ? t("giteeEmpty") : (mode === "skills" ? t("skillsEmpty") : t("marketEmpty")))]
						: marketShown.length === 0
							? [el("p", { key: "m", className: styles.status },
								officialOnly && market.data.some((item) => item.official === undefined || item.official === null)
									? t("officialChecking")
									: t("marketEmpty"))]
							: marketShown.map((item) => {
							const desc = item.description ?? "";
							const long = desc.length > 90;
							const open = expandedDescs[item.fullName] === true;
							const shown = long && !open ? desc.slice(0, 90) + "…" : desc;
							const installedMatch = state.status === "ready"
								? state.data.entries.find((entry) =>
									(entry.repository && entry.repository.includes(item.fullName.toLowerCase()))
									|| moduleShortName(entry.moduleName) === item.fullName.toLowerCase().split("/")[1])
								: null;
							return el("li", { key: item.fullName, className: styles.item },
								el("div", { className: styles.itemTop },
									el("a", { href: item.htmlUrl, target: "_blank", rel: "noreferrer" }, item.fullName),
									el("span", { className: styles.stars }, "★ " + item.stars),
									item.official === true
										? el("span", { className: styles.tag, "data-user": "true", title: t("officialTitle") }, t("officialBadge"))
										: item.aggregate === true
											? el("span", { className: styles.tag, title: t("aggregateTitle") }, t("aggregateBadge"))
											: null,
									item.hasSkill === true || item.skillTopics !== undefined
										? el("span", { className: styles.tag, "data-skill": "true", title: t("skillTitle") + (Array.isArray(item.skillTopics) && item.skillTopics.length > 0 ? "（" + item.skillTopics.join(" / ") + "）" : "") }, t("skillBadge"))
										: null,
									item.hasSuite === true
										? el("span", { className: styles.tag, "data-suite": "true", title: t("suiteTitle") }, t("suiteBadge"))
										: null,
								),
								desc ? (long
									? (open
										? el("div", { className: styles.descWrap },
											el("div", { className: styles.descTopbar },
												el("button", {
													type: "button",
													onClick: () => setExpandedDescs((prev) => ({ ...prev, [item.fullName]: false })),
												}, t("collapseDesc"))),
											el("p", { className: styles.desc }, desc),
											el("div", { className: styles.descTopbar },
												el("button", {
													type: "button",
													onClick: () => setExpandedDescs((prev) => ({ ...prev, [item.fullName]: false })),
												}, t("collapseDesc"))))
										: el("div", null,
											el("p", { className: styles.desc }, shown),
											el("button", {
												type: "button",
												onClick: () => setExpandedDescs((prev) => ({ ...prev, [item.fullName]: true })),
											}, t("expandDesc"))))
									: el("p", { className: styles.desc }, desc))
								: null,
								el("div", { className: styles.rowTop },
									el("button", {
										type: "button",
										disabled: repoInfo !== null && repoInfo.status === "loading" && repoInfo.repo === item.fullName,
										onClick: () => inspect(item),
									}, t("view")),
									repoLandOn && mode !== "skills"
										? el("button", {
											type: "button",
											className: styles.toggle,
											title: repoLandTitleText(),
											onClick: () => repoLandEntry(item.fullName),
										}, repoLanded.some((r) => r.repo === item.fullName) ? t("repoLandLanded") + " ✓" : t("repoLandEntry"))
										: null,
									el("button", {
										type: "button",
										className: styles.toggle,
										title: t("aiEmpowerTitle"),
										onClick: () => openAiFor(item.fullName),
									}, t("aiEmpowerLabel")),
									// 技能条目（技能市场模式 / 技能索引数据）：走技能安装通道（clone → ~/.dsh/skills）
									item.skillTopics !== undefined
										? (() => {
											const skillName = item.fullName.split("/")[1];
											const already = installedSkills.some((s) => s.name === skillName);
											return el("button", {
												type: "button",
												className: styles.toggle,
												disabled: installing === item.fullName || already,
												title: already ? t("skillUninstallHint") : undefined,
												onClick: () => startSkillJob(item),
											}, installing === item.fullName ? t("installingLocal") : (already ? t("skillInstalledTag") : t("installSkill")));
										})()
										: item.fullName === "deepseek-ai/deepseek-harness"
											? (updateMap[item.fullName] !== undefined
												? (confirmFrameworkUpgrade
													? el("button", {
														type: "button",
														className: styles.toggle,
														disabled: frameworkUpgrading,
														onClick: doFrameworkUpgrade,
													}, frameworkUpgrading ? t("installingLocal") : t("frameworkUpgradeConfirm"))
													: el("button", {
														type: "button",
														className: styles.toggle,
														disabled: frameworkUpgrading,
														title: t("frameworkUpgradeTitle"),
														onClick: () => setConfirmFrameworkUpgrade(true),
													}, t("frameworkUpgradeBtn") + " → v" + updateMap[item.fullName]))
												: el("button", {
													type: "button",
													className: styles.toggle,
													disabled: true,
													title: t("frameworkUpToDateTitle"),
												}, t("frameworkUpToDate")))
											: updateMap[item.fullName] !== undefined
												? el("button", {
													type: "button",
													className: styles.toggle,
													disabled: installing === item.fullName,
													onClick: () => startJob("", installedMatch.moduleName, "github", "plugin", true),
												}, installing === item.fullName ? t("installingLocal") : t("update") + " → v" + updateMap[item.fullName])
												: el("button", {
													type: "button",
													className: styles.toggle,
													disabled: installing === item.fullName,
													onClick: () => addLocal(item),
												}, installing === item.fullName ? t("installingLocal") : (installedMatch !== null && installedMatch !== undefined ? t("update") : t("addLocal"))),
								),
							);
						});
			let detail = null;
			if (repoInfo !== null) {
				if (repoInfo.status === "loading") {
					detail = el("div", { className: styles.detail }, el("p", { className: styles.status }, t("repoLoading")));
				} else if (repoInfo.status === "error") {
					detail = el("div", { className: styles.detail },
						el("p", { className: styles.status, "data-error": "true" }, t("repoError") + "：" + repoInfo.error.message));
				} else {
					const info = repoInfo.data;
					const detailSkillName = info.skill?.name ?? info.skillName ?? repoInfo.repo.split("/")[1];
					const detailSkill = installedSkills.find((s) => s.name === detailSkillName) ?? null;
					const detailSkillInstalled = detailSkill !== null;
					const detailSkillDisabled = detailSkill?.disabled === true;
					detail = el("div", { className: styles.detail },
						el("div", { className: styles.rowTop },
							el("strong", { className: styles.name }, repoInfo.repo),
							info.dshHint ? el("span", { className: styles.tag, "data-user": "true" }, t("dshHint")) : null,
							info.hasSkill === true ? el("span", { className: styles.tag, "data-skill": "true", title: t("skillTitle") }, t("skillBadge")) : null,
							info.hasSuite === true ? el("span", { className: styles.tag, "data-suite": "true", title: t("suiteTitle") }, t("suiteBadge")) : null,
						),
						info.description ? el("p", { className: styles.desc }, info.description) : null,
						info.hasSkill === true && info.skill !== null && (info.skill.name || info.skill.description || info.skill.whenToUse)
							? el("div", null,
								el("p", { className: styles.status }, t("skillMetaLabel") + "："),
								info.skill.name ? el("p", { className: styles.status }, t("skillNameLabel") + "：" + info.skill.name) : null,
								info.skill.description ? el("p", { className: styles.desc }, info.skill.description) : null,
								info.skill.whenToUse ? el("p", { className: styles.status }, t("skillWhenToUseLabel") + "：" + info.skill.whenToUse) : null,
								Array.isArray(info.skillTopics) && info.skillTopics.length > 0
									? el("p", { className: styles.status }, t("skillTopicsLabel") + "：" + info.skillTopics.join(" / "))
									: null,
							)
							: null,
						info.readme !== null && (info.readme.title || info.readme.summary)
							? el("div", null,
								el("p", { className: styles.status }, t("readmeLabel") + "："),
								info.readme.title ? el("strong", null, info.readme.title + "。") : null,
								info.readme.summary ? el("p", { className: styles.desc }, info.readme.summary) : null,
							)
							: null,
						el("p", { className: styles.status },
							info.hasSuite === true && info.hasPackageJson === false
								? t("suiteRepoNote")
								: (info.hasSkill === true && info.hasPackageJson === false
									? t("skillRepoNote")
									: (t("packageName") + "：" + (info.packageName ?? t("noPackage"))))),
						info.installCommand
							? el("div", null,
								el("p", { className: styles.status }, t("officialInstallLabel") + "："),
								el("pre", { className: styles.cmdBlock, style: { margin: "4px 0", padding: "8px 10px", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", overflowX: "auto", fontSize: "12px", lineHeight: "18px", whiteSpace: "pre-wrap", wordBreak: "break-all" } }, info.installCommand),
								el("button", { type: "button", className: styles.toggle, onClick: () => copyInstallCommand(info.installCommand) }, t("copyInstallCmd")))
							: null,
						info.packageName !== null && info.packageName !== undefined && state.status === "ready"
							? (() => {
								const entry = state.data.entries.find((candidate) => candidate.moduleName === info.packageName);
								return entry ? el("p", { className: styles.status },
									t("installedAt") + "：" + (entry.installDate ?? "?") + (entry.version ? " · v" + entry.version : "")) : null;
							})()
							: null,
						info.hasSkill === true && detailSkillInstalled
							? el("p", { className: styles.status },
								t("skillDetailInstalled") + "：" + detailSkillName
									+ (detailSkillDisabled ? " · " + t("skillDetailDisabled") : "")
									+ (detailSkill.path ? " · " + t("skillDetailPath") + " " + detailSkill.path : ""))
							: null,
						info.packageName ? el("button", {
							type: "button",
							className: styles.toggle,
							disabled: installing === repoInfo.repo,
							onClick: () => startJob(repoInfo.repo, info.packageName),
						}, installing === repoInfo.repo ? t("installing") : (state.status === "ready" && state.data.entries.some((candidate) => candidate.moduleName === info.packageName) ? t("update") : t("install"))) : null,
						info.hasSkill === true ? el("button", {
							type: "button",
							className: styles.toggle,
							disabled: installing === repoInfo.repo || detailSkillInstalled,
							title: detailSkillInstalled ? t("skillUninstallHint") : undefined,
							onClick: () => startSkillJob({ fullName: repoInfo.repo, source: repoInfo.source ?? "github" }),
						}, installing === repoInfo.repo ? t("installing") : (detailSkillInstalled ? t("skillInstalledTag") : t("installSkill"))) : null,
						info.hasSuite === true && info.hasPackageJson === false ? el("button", {
							type: "button",
							className: styles.toggle,
							disabled: installing === repoInfo.repo,
							title: t("suiteTitle"),
							onClick: () => startSuiteJob({ fullName: repoInfo.repo, source: repoInfo.source ?? "github" }),
						}, installing === repoInfo.repo ? t("installing") : t("suiteInstall")) : null,
						info.hasSkill === true && detailSkillInstalled && !detailSkill.system
							? el("button", {
								type: "button",
								className: styles.toggle,
								disabled: togglingSkill === detailSkillName,
								onClick: () => doToggleSkill(detailSkillName, detailSkillDisabled),
							}, togglingSkill === detailSkillName ? t("installingLocal") : (detailSkillDisabled ? t("skillEnable") : t("skillDisable")))
							: null,
						(info.privateRoot || !info.hasPackageJson) ? el("div", null,
							info.privateRoot ? el("p", { className: styles.status, "data-error": "true" }, t("privateRootHint")) : null,
							el("p", { className: styles.status }, t("subpackagesTitle") + "："),
							subpackages === null ? null
								: subpackages.status === "loading"
									? el("p", { className: styles.status }, t("subpackagesLoading"))
									: subpackages.status === "error"
										? el("p", { className: styles.status, "data-error": "true" }, t("subpackagesError"))
										: subpackages.list.length === 0
											? el("p", { className: styles.status }, t("subpackagesEmpty"))
											: el("ul", { className: styles.market }, subpackages.list.map((sub) =>
												el("li", { key: sub.name, className: styles.item },
													el("div", { className: styles.itemTop },
														el("code", { className: styles.name }, sub.name)),
													el("div", { className: styles.rowTop },
														el("button", {
															type: "button",
															className: styles.toggle,
															disabled: installing === sub.name,
															onClick: () => startJob(repoInfo.repo, sub.name),
														}, installing === sub.name ? t("installing") : t("install")))))))
						: null,
					);
				}
			}
			// 升级卡片显示条件（v0.3.40 明确化，2026-09-11 用户连问两次「卡片为什么还在」）：
			//  - 升级/回滚**进行中** → 显示（实时进度）；
			//  - 结果**是自愈出来的**（脚本被强杀后按现实判定，用户根本没看着它跑）→ 不弹卡片，
			//    结果常驻在「功能包 → 框架」里，不打扰人；
			//  - 结束的卡片点过叉号 → 只关闭**那一次**（按状态文件时间戳认身份），
			//    下次升级时间戳变了才会再弹；旧实现按 status 字符串记，导致"关了 failed 又冒出 done"。
			const fwRunKey = frameworkStatus !== null ? String(frameworkStatus.at ?? "") : "";
			const fwDismissedRun = (() => {
				try { return frameworkStatus !== null && localStorage.getItem("pc-fw-dismiss-at") === fwRunKey; } catch { return false; }
			})();
			const fwTerminal = frameworkStatus !== null && (frameworkStatus.status === "done" || frameworkStatus.status === "failed");
			const fwShowCard = frameworkStatus !== null && frameworkStatus.status !== "idle" && !fwStatusDismissed
				&& !fwDismissedRun
				&& !(fwTerminal && frameworkStatus.reconciled !== undefined);
			// 门控（兼容门总开关）取值：state 未就绪时按默认「都开」，与服务端默认一致
			const gateReady = state !== null && state.status === "ready";
			const gateAutoDisable = !gateReady || (state.data.compatGate ?? {}).autoDisable !== false;
			const gateAutoDetect = !gateReady || (state.data.compatGate ?? {}).autoDetect !== false;
			const gatePendingCount = gateReady ? (state.data.compatPending?.pending ?? []).length : 0;
			// 「功能包 → 框架」按钮角标：升级进行中 ⟳ / 上次失败 ✕ / 有可用更新 ↑（优先级从高到低）
			const fwRunning = frameworkStatus !== null
				&& frameworkStatus.status !== "idle" && frameworkStatus.status !== "done" && frameworkStatus.status !== "failed";
			const fwBadge = fwRunning ? " ⟳" : (frameworkStatus?.status === "failed" ? " ✕" : (fwCheck?.target ? " ↑" : ""));
			return el("section", { ref: sectionRef, className: styles.section, "aria-busy": state.status === "loading" },
				state.status === "ready" && state.data.compat && !state.data.compat.supported
					? el("p", { className: styles.message, "data-error": "true" }, state.data.compat.notice)
					: null,
				state.status === "ready" && comps.length > 0 && details === null && repoInfo === null
					? el("button", {
						type: "button",
						className: styles.compToggle,
						style: compCardTop !== null ? { top: compCardTop, left: compCollapsed ? "8px" : "336px" } : { left: compCollapsed ? "8px" : "336px" },
						title: t(compCollapsed ? "compExpandTitle" : "compCollapseTitle"),
						"aria-label": t(compCollapsed ? "compExpandTitle" : "compCollapseTitle"),
						onClick: () => setCompCollapsed((v) => {
							const next = !v;
							try { localStorage.setItem("pc-comp-collapsed", next ? "1" : "0"); } catch {}
							return next;
						}),
					}, compCollapsed ? "▶" : "◀")
					: null,
				state.status === "ready" && comps.length > 0 && !compCollapsed && details === null && repoInfo === null
					? el("div", { className: styles.compCard, style: compCardTop !== null ? { top: compCardTop } : undefined },
						el("div", { className: styles.rowTop },
							el("strong", { className: styles.name }, t("aiEmpowerComponents") + "（" + comps.length + "）"),
							el("button", { type: "button", className: styles.toggle, onClick: refreshComps }, t("compRefresh")),
							comps.length > 1
								? el("button", { type: "button", className: styles.toggle, "data-active": compDropOpen ? "true" : "false", title: t("compDropTitle"), onClick: () => setCompDropOpen((v) => !v) }, compDropOpen ? "▴" : "▾")
								: null),
						compDropOpen && comps.length > 1
							? el("div", { className: styles.compDrop },
								comps.map((c) =>
									el("button", { key: c.id, type: "button", className: styles.compDropRow, onClick: () => { if (c.uiUrl) window.open(c.uiUrl, "_blank", "noopener"); } },
										el("span", null, c.name + "（" + t(c.running ? "compRunning" : "compStopped") + "）"),
										el("span", { className: styles.compDropUrl }, c.uiUrl ?? t("compNoUrl")))))
							: null,
						comps.map((c) =>
							el("div", { key: c.id, className: styles.rowTop, style: { flexWrap: "wrap" } },
								el("strong", { className: styles.name, style: { flex: "1 1 auto" } }, c.name),
								el("span", { className: styles.tag, "data-enabled": c.running ? "true" : "false" }, c.running ? t("compRunning") : t("compStopped")),
								(c.running && c.healthy !== null) ? el("span", { className: styles.tag, "data-enabled": c.healthy ? "true" : "false" }, c.healthy ? t("compHealthy") : t("compUnhealthy")) : null,
								el("div", { className: styles.rowTop },
									el("div", {
										className: styles.pcSwitch,
										"data-on": c.autoStart === true ? "true" : "false",
										role: "switch",
										"aria-checked": c.autoStart === true ? "true" : "false",
										title: t("compAutoTitle"),
										onClick: () => compAuto(c.id, c.autoStart !== true),
									}, el("div", { className: styles.pcSwitchKnob })),
									el("button", { type: "button", className: styles.toggle, disabled: c.running || compBusy === c.id, onClick: () => compAction(c.id, "start") }, t("compStart")),
									el("button", { type: "button", className: styles.toggle, disabled: !c.running || compBusy === c.id, onClick: () => compAction(c.id, "stop") }, t("compStop")),
									el("button", { type: "button", className: styles.toggle, disabled: compBusy === c.id, onClick: () => compStatusOne(c.id) }, t("compStatus")),
									el("button", { type: "button", className: styles.toggle, disabled: !c.uiUrl, title: c.uiUrl ?? "", onClick: () => { if (c.uiUrl) window.open(c.uiUrl, "_blank", "noopener"); } }, t("compOpen"))))))
					: null,
				fwPanelOpen
					? el("div", { className: styles.modalBackdrop, onClick: (event) => { if (event.target === event.currentTarget) { setFwPanelOpen(false); setFwConfirmPanel(false); } } },
						el("div", { className: styles.modalCard, style: { maxWidth: 560 } },
							el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
								el("strong", { className: styles.name }, t("fwPanelTitle")),
								el("button", { type: "button", className: styles.trashBtn, style: { fontSize: 14, padding: "4px 8px" }, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => { setFwPanelOpen(false); setFwConfirmPanel(false); } }, "✕")),
							// ① 版本信息：当前 / 可用更新
							el("p", { className: styles.status },
								t("fwPanelCurrent") + "：" + (fwCheck?.current ?? (state.status === "ready" ? state.data.framework?.version : null) ?? "?")
								+ (fwCheckBusy ? "（" + t("fwPanelChecking") + "）" : "")),
							fwCheck === null
								? null
								: fwCheck.target
									? el("p", { className: styles.status, "data-pending": "true" }, t("fwPanelAvailable").replace("{v}", fwCheck.target) + "（latest " + (fwCheck.latest ?? "—") + " · next " + (fwCheck.next ?? "—") + "）")
									: fwCheck.registryError
										? el("p", { className: styles.message, "data-error": "true" }, t("fwPanelCheckFailed").replace("{err}", fwCheck.registryError))
										: el("p", { className: styles.status }, t("fwPanelUpToDate").replace("{latest}", fwCheck.latest ?? "—").replace("{next}", fwCheck.next ?? "—")),
							// ② 上次/当前升级记录（卡片可被永久关闭，这里是常驻的真相入口）
							frameworkStatus !== null && frameworkStatus.status !== "idle"
								? el("div", { style: { flexDirection: "column", gap: 8, display: "flex" } },
									el("strong", { className: styles.name }, t("frameworkUpgradeBtn") + " " + (frameworkStatus.status === "done" ? "✓" : (frameworkStatus.status === "failed" ? "✕" : "⟳"))),
									fwStepsView(frameworkStatus),
									frameworkStatus.status === "failed" && frameworkStatus.frameworkAtTarget
										? el("p", { className: styles.status }, t("fwFailedButUpgraded").replace("{v}", frameworkStatus.frameworkAtTarget))
										: null,
									frameworkStatus.reconciled
										? el("p", { className: styles.status, "data-pending": "true" }, "⚠ " + frameworkStatus.reconciled.note)
										: null,
									frameworkStatus.stalled && frameworkStatus.note
										? el("p", { className: styles.message, "data-warn": "true" }, "⚠ " + frameworkStatus.note)
										: null,
									frameworkStatus.message ? el("p", { className: styles.status, "data-error": frameworkStatus.status === "failed" ? "true" : undefined }, frameworkStatus.message) : null)
								: el("p", { className: styles.status }, t("fwPanelNoRecord")),
							// ③ 操作：升级（两步确认）/ 回滚 / 重启 / 重新检查
							el("div", { className: styles.rowTop, style: { flexWrap: "wrap" } },
								fwCheck?.target
									? (fwConfirmPanel
										? el("div", { style: { flexDirection: "column", gap: 8, display: "flex", flexBasis: "100%" } },
											el("p", { className: styles.message, "data-warn": "true" }, t("fwPanelConfirmBody").replace("{v}", fwCheck.target)),
											el("div", { className: styles.rowTop },
												el("button", { type: "button", className: styles.toggle, disabled: frameworkUpgrading, onClick: () => { setFwConfirmPanel(false); doFrameworkUpgrade(); } }, frameworkUpgrading ? t("installingLocal") : t("frameworkUpgradeConfirm")),
												el("button", { type: "button", className: styles.toggle, onClick: () => setFwConfirmPanel(false) }, t("closeModal"))))
										: el("button", { type: "button", className: styles.toggle, disabled: frameworkUpgrading, title: t("frameworkUpgradeTitle"), onClick: () => setFwConfirmPanel(true) }, t("frameworkUpgradeBtn") + " → v" + fwCheck.target))
									: null,
								rollbackUsable
									? el("button", { type: "button", className: styles.toggle, title: t("frameworkRollbackTitle"), disabled: frameworkUpgrading, onClick: doFrameworkRollback }, t("frameworkRollbackBtn") + " → " + (rollbackInfo.from ?? "?"))
									: (rollbackInfo !== null && rollbackInfo !== undefined
										? el("span", { className: styles.status }, t("fwRollbackDone").replace("{v}", String(rollbackInfo.from ?? "?")))
										: null),
								el("button", { type: "button", className: styles.toggle, onClick: fwStatusRefresh }, t("fwPanelRefreshStatus")),
								el("button", { type: "button", className: styles.toggle, disabled: fwCheckBusy, onClick: () => fwCheckRefresh(true) }, fwCheckBusy ? t("fwPanelChecking") : t("fwPanelRecheck"))),
							el("div", { className: styles.rowTop },
								el("button", { type: "button", className: styles.toggle, onClick: () => { setMessage(t("restarting")); call("/plugin-console/restart", {}).then(() => { window.setTimeout(() => window.location.reload(), 12000); }, () => {}); } }, t("restartService")))))
					: null,
				gateOpen
					? el("div", { className: styles.modalBackdrop, onClick: (event) => { if (event.target === event.currentTarget) setGateOpen(false); } },
						el("div", { className: styles.modalCard, style: { maxWidth: 520 } },
							el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
								el("strong", { className: styles.name }, t("gateModalTitle")),
								el("button", { type: "button", className: styles.trashBtn, style: { fontSize: 14, padding: "4px 8px" }, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => setGateOpen(false) }, "✕")),
							el("div", { style: { flexDirection: "column", gap: 12, display: "flex" } },
								el("div", { className: styles.rowTop, style: { justifyContent: "space-between", gap: 12 } },
									el("span", { className: styles.status, style: { flex: 1 } }, t("compatGateAutoDisable")),
									el("div", {
										className: styles.pcSwitch,
										"data-on": gateAutoDisable ? "true" : "false",
										role: "switch",
										"aria-checked": gateAutoDisable ? "true" : "false",
										"aria-label": t("compatGateAutoDisable"),
										title: t("compatGateHint"),
										onClick: () => setCompatGate({ autoDisable: !gateAutoDisable }),
									}, el("div", { className: styles.pcSwitchKnob }))),
								el("div", { className: styles.rowTop, style: { justifyContent: "space-between", gap: 12 } },
									el("span", { className: styles.status, style: { flex: 1 } }, t("compatGateAutoDetect")),
									el("div", {
										className: styles.pcSwitch,
										"data-on": gateAutoDetect ? "true" : "false",
										role: "switch",
										"aria-checked": gateAutoDetect ? "true" : "false",
										"aria-label": t("compatGateAutoDetect"),
										title: t("compatGateHint"),
										onClick: () => setCompatGate({ autoDetect: !gateAutoDetect }),
									}, el("div", { className: styles.pcSwitchKnob }))),
								el("p", { className: styles.message }, t("compatGateHint")),
								el("p", { className: styles.status, "data-pending": gatePendingCount > 0 ? "true" : undefined },
									gatePendingCount > 0 ? t("gatePendingInfo").replace("{n}", String(gatePendingCount)) : t("gatePendingNone")))))
					: null,
				aiOpen
					? el("div", { className: styles.modalBackdrop },
						el("div", { className: styles.modalCard, style: { maxWidth: 560 } },
							el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
								el("strong", { className: styles.name }, t("aiEmpowerLabel")),
								el("button", { type: "button", className: styles.trashBtn, style: { fontSize: 14, padding: "4px 8px" }, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => setAiOpen(false) }, "✕")),
							aiJobsList.length > 1
								? el("div", { style: { flexDirection: "column", gap: 6, display: "flex", maxHeight: 120, overflowY: "auto" } },
									aiJobsList.map((task) =>
										el("button", {
											key: task.jobId,
											type: "button",
											className: styles.toggle,
											style: aiJob !== null && aiJob.jobId === task.jobId ? { borderColor: "var(--dsw-alias-state-business-primary)", color: "var(--dsw-alias-state-business-primary)" } : undefined,
											onClick: () => aiSelect(task.jobId),
										}, (task.displayName ?? task.source) + "：" + (task.status === "running" ? (t("aiEmpowerExecuting") + (task.progress && task.progress.done ? "（" + task.progress.done + "/" + task.progress.total + "）" : "")) : task.status === "plan-ready" ? t("aiEmpowerPlanTitle") : task.status === "done" ? t("aiEmpowerDone") : task.status === "failed" ? t("aiEmpowerFail") : task.status ?? "?"))))
								: null,
							aiJob === null || (aiJob.status === "running" && aiJob.stage === "planning")
								? el("div", { style: { flexDirection: "column", gap: "10px", display: "flex" } },
									el("section", null,
										el("input", { type: "text", placeholder: t("aiEmpowerSrcTitle"), value: aiSource, disabled: aiRunning, onChange: (event) => setAiSource(event.currentTarget.value), onKeyDown: (event) => { if (event.key === "Enter" && !aiRunning) aiStartPlan(); }, style: { width: "100%", boxSizing: "border-box", font: "inherit", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" } }),
									el("div", { className: styles.rowTop },
										el("button", { type: "button", className: styles.toggle, disabled: aiRunning || aiSource.trim() === "", onClick: aiStartPlan }, t("aiEmpowerLabel")),
										aiRunning ? el("span", { className: styles.message }, t("aiEmpowerWaiting") + (aiJob?.source ? "（" + aiJob.source + "）" : "")) : null,
										aiRunning ? el("button", { type: "button", className: styles.toggle, onClick: () => { call("/plugin-console/ai-empower/cancel", { jobId: aiJob ? aiJob.jobId : "" }).catch(() => {}); aiResetLocal(); } }, t("aiEmpowerCancel")) : null)))
								: aiJob.status === "plan-ready"
									? el("div", { style: { flexDirection: "column", gap: "10px", display: "flex" } },
										el("div", { className: styles.rowTop },
											el("strong", { className: styles.name }, (aiJob.displayName ?? aiJob.source) + "："),
											el("span", { className: styles.tag }, t("aiEmpowerType") + "：" + (t("aiEmpowerTypeMapping")[aiJob.type] ?? aiJob.type ?? "?"))),
									aiJob.frameworkCheck
										? el("p", { className: styles.status, "data-error": aiJob.frameworkCheck.check?.decision === "fail" ? "true" : undefined, title: aiJob.frameworkCheck.check?.reason ?? undefined }, t("aiEmpowerFrameworkCheck") + "：" + (aiJob.frameworkCheck.summary ?? "") + (aiJob.frameworkCheck.frameworkVersion ? "（框架 " + aiJob.frameworkCheck.frameworkVersion + "）" : ""))
										: null,
							aiJob?.workspace ? el("p", { className: styles.status }, t("aiWorkspaceInfo") + "：" + aiJob.workspace) : null,
							aiJob.summary ? el("p", { className: styles.message }, aiJob.summary) : null,
										el("p", { className: styles.message, "data-error": "true" }, t("aiPlanHint")),
										(aiJob.servers ?? []).length > 0
											? el("p", { className: styles.message }, (aiJob.servers ?? []).map((s) => (s.name ?? "?") + (s.port ? "（端口 " + s.port + "）" : "")).join("、"))
											: null,
										el("strong", { className: styles.name }, t("aiEmpowerSteps")),
										el("div", { style: { flexDirection: "column", gap: "6px", display: "flex", maxHeight: 220, overflowY: "auto" } },
											(aiJob.steps ?? []).map((s) =>
												el("label", { key: s.index, className: styles.consentRemember, style: { alignItems: "flex-start" } },
													el("input", { type: "checkbox", checked: aiSelected[s.index] === true, onChange: (event) => setAiSelected((prev) => ({ ...prev, [s.index]: event.currentTarget.checked })) }),
													el("span", null, (s.index + 1) + ". [" + s.action + "] " + (s.description ?? "") + (s.path ? " → " + s.path : "")))),
										el("div", { className: styles.rowTop },
											el("button", { type: "button", className: styles.toggle, onClick: aiRun }, t("aiEmpowerRun")),
											el("button", { type: "button", className: styles.toggle, onClick: aiResetLocal }, t("aiEmpowerCancel")))))
									: el("div", { style: { flexDirection: "column", gap: "10px", display: "flex" } },
										el("p", { className: styles.message, "data-error": aiJob.status === "failed" ? "true" : undefined }, (aiJob.status === "done" ? t("aiEmpowerDone") : aiJob.status === "failed" ? t("aiEmpowerFail") + "：" + (aiJob.error ?? "?") : t("aiEmpowerExecuting")) + (aiJob.source ? "（" + aiJob.source + "）" : "") + (aiJob.status === "running" ? " " + (aiJob.progress?.done ?? 0) + "/" + (aiJob.progress?.total ?? "?") : "")),
										el("pre", { style: { maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 8, fontSize: 11, margin: 0, fontFamily: "inherit" } }, aiJob.logText ?? ""),
										el("div", { className: styles.rowTop },
											(aiJob.status === "running") ? el("button", { type: "button", className: styles.toggle, onClick: async () => { await aiCancel(); aiResetLocal(); } }, t("aiEmpowerCancel")) : null,
											el("button", { type: "button", className: styles.toggle, onClick: aiResetLocal }, t("closeModal"))))))
					: null,
				repoLandOpen
					? el("div", { className: styles.modalBackdrop },
						el("div", { className: styles.modalCard, style: { maxWidth: 560 } },
							el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
								el("strong", { className: styles.name }, t("repoLandLabel")),
								el("button", { type: "button", className: styles.trashBtn, style: { fontSize: 14, padding: "4px 8px" }, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => { setRepoLandOpen(false); setRepoLandResult(null); } }, "✕")),
							el("p", { className: styles.message }, repoLandTitleText()),
							el("div", { className: styles.rowTop, style: { flexWrap: "wrap" } },
								el("span", { className: styles.message }, t("repoLandDirLabel") + "：" + (repoLandDir || "—")),
								el("input", { type: "text", value: repoLandDirInput, onChange: (event) => setRepoLandDirInput(event.currentTarget.value), style: { flex: 1, minWidth: 120, font: "inherit", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" } }),
								el("button", { type: "button", className: styles.toggle, onClick: repoLandSaveDir }, t("repoLandSaveDir"))),
							el("section", null,
								el("input", { type: "text", placeholder: t("repoLandPlaceholder"), value: repoLandInput, disabled: repoLandBusy, onChange: (event) => setRepoLandInput(event.currentTarget.value), onKeyDown: (event) => { if (event.key === "Enter" && !repoLandBusy) repoLandStart(); }, style: { width: "100%", boxSizing: "border-box", font: "inherit", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" } }),
							el("div", { className: styles.rowTop },
								el("button", { type: "button", className: styles.toggle, disabled: repoLandBusy || repoLandInput.trim() === "", onClick: repoLandStart }, repoLandBusy ? t("repoLandBusy") : t("repoLandLabel"))),
							repoLandResult !== null
								? (repoLandResult.ok === true
									? el("div", { className: styles.rowTop },
										el("p", { className: styles.message, style: { flex: 1, minWidth: 0, wordBreak: "break-all" } }, t("repoLandDone") + repoLandResult.path),
										el("button", { type: "button", className: styles.toggle, onClick: repoLandOpenFolder }, t("repoLandOpenFolder")))
									: el("p", { className: styles.message, "data-error": "true" }, t("failed") + "：" + (repoLandResult.error ?? "?")))
								: null,
							el("strong", { className: styles.name }, t("repoLandList") + "（" + repoLanded.length + "）"),
							repoLanded.length === 0
								? el("p", { className: styles.status }, "—")
								: el("div", { style: { flexDirection: "column", gap: 6, display: "flex", maxHeight: 180, overflowY: "auto" } },
									repoLanded.map((item) =>
										el("div", { key: item.repo, className: styles.rowTop },
											el("strong", { className: styles.name, style: { flex: "1 1 auto" } }, item.repo),
											el("button", { type: "button", className: styles.toggle, onClick: () => { call("/plugin-console/repo-open", { path: item.path }).catch(() => {}); } }, t("repoLandOpenFolder")),
											el("button", { type: "button", className: styles.trashBtn, title: t("repoLandRemoveConfirm"), "aria-label": t("repoLandRemoveConfirm"), onClick: () => repoLandRemove(item) }, "✕"))))
							)))
					: null,
				state.status === "ready" && state.data.framework && state.data.framework.upgraded === true && !frameworkNoticeDismissed
					? el("div", { className: styles.messageRow },
						el("p", { className: styles.message }, t("frameworkUpgradeNotice").replace("{from}", state.data.framework.from ?? "?").replace("{to}", state.data.framework.version ?? "?").replace("{dir}", state.data.framework.backupDir ?? "").replace("{patch}", state.data.framework.patchApplied === true ? t("frameworkPatchApplied") : t("frameworkPatchSkipped") + (state.data.framework.patchNote ? "：" + state.data.framework.patchNote : ""))),
						el("button", { type: "button", className: styles.toggle, onClick: () => setFrameworkNoticeDismissed(true) }, t("closeModal")))
					: null,
				fwShowCard && frameworkStatus.status !== "done"
					? el("button", {
						type: "button",
						className: styles.relaunchFloat,
						title: t("relaunchTitle"),
						"aria-label": t("relaunchBtn"),
						onClick: () => {
							call("/plugin-console/framework-relaunch", {}).then(
								(data) => { if (data && data.ok === true) setMessage(t("relaunchDone")); },
								(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
							);
						},
					}, t("relaunchBtn"))
					: null,
					el("button", {
						type: "button",
						style: { position: "fixed", left: 12, bottom: 12, zIndex: 1000, opacity: 0.75 },
						title: t("cleanResiduals"),
						onClick: () => {
							setMessage(t("cleanResiduals") + "…");
							call("/plugin-console/clean-residuals", {}).then(
								(data) => {
									if (data && data.ok === true) setMessage(t("cleanResiduals") + "：" + (data.count === 0 ? "无残余" : "已清理 " + data.count + " 项"));
								},
								(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
							);
						},
					}, "🧹 " + t("cleanResiduals")),
				fwShowCard
					? el("div", { className: styles.detail },
						el("div", { className: styles.rowTop },
							el("strong", { className: styles.name }, t("frameworkUpgradeBtn") + " " + (frameworkStatus.status === "done" ? "✓" : (frameworkStatus.status === "failed" ? "✕" : t("installingLocal")))),
							el("button", { type: "button", className: styles.trashBtn, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => {
								// 结束的卡片关闭 = 只关这一次（按运行时间戳认身份）；进行中的关闭 = 仅本会话隐藏
								if (fwTerminal) {
									try { localStorage.setItem("pc-fw-dismiss-at", fwRunKey); } catch {}
								}
								setFwStatusDismissed(true);
							} }, "✕")),
						fwStepsView(frameworkStatus),
						frameworkStatus.status === "failed" && frameworkStatus.frameworkAtTarget
							? el("p", { className: styles.status }, t("fwFailedButUpgraded").replace("{v}", frameworkStatus.frameworkAtTarget))
							: null,
						frameworkStatus.reconciled
							? el("p", { className: styles.status, "data-pending": "true" }, "⚠ " + frameworkStatus.reconciled.note)
							: null,
						frameworkStatus.stalled && frameworkStatus.note
							? el("p", { className: styles.message, "data-warn": "true" }, "⚠ " + frameworkStatus.note)
							: null,
						frameworkStatus.message ? el("p", { className: styles.status, "data-error": frameworkStatus.status === "failed" ? "true" : undefined }, frameworkStatus.message) : null,
						rollbackUsable
							? el("div", { className: styles.rowTop },
								el("button", {
									type: "button",
									className: styles.toggle,
									title: t("frameworkRollbackTitle"),
									disabled: frameworkUpgrading,
									onClick: doFrameworkRollback,
								}, t("frameworkRollbackBtn") + " → " + (rollbackInfo.from ?? "?")))
							: null)
					: null,
				message !== null ? el("div", { className: styles.messageRow }, el("p", { className: styles.message }, message), reloadHint ? el("button", { type: "button", className: styles.toggle, onClick: () => window.location.reload() }, t("reloadPage")) : null, restartHint ? el("button", { type: "button", className: styles.toggle, onClick: () => { setMessage(t("restarting")); call("/plugin-console/restart", {}).then(() => { window.setTimeout(() => window.location.reload(), 12000); }, () => {}); } }, t("restartService")) : null) : null,
				// 适配门「软禁」的风险确认（用户定案：自动禁用，但允许手动强行启用）
				riskyConfirm !== null
					? el("div", { className: styles.detail, "data-risky": "true" },
						el("strong", { className: styles.name, "data-pending": "true" }, t("riskyEnableTitle") + "（" + riskyConfirm.entryId + "）"),
						el("p", { className: styles.status, "data-pending": "true" }, t("riskyEnableBody")
							+ (riskyConfirm.frameworkVersion ? "（框架 " + riskyConfirm.frameworkVersion + "）" : "")
							+ (riskyConfirm.checkNote ? "；判定依据：" + riskyConfirm.checkNote : "")),
						el("div", { className: styles.rowTop },
							el("button", {
								type: "button",
								className: styles.toggle,
								disabled: busy === riskyConfirm.entryId,
								onClick: () => {
									const target = (state.status === "ready" ? state.data.entries : []).find((e) => e.entryId === riskyConfirm.entryId) ?? null;
									if (target === null) { setRiskyConfirm(null); return; }
									toggle(target, true, true);
								},
							}, t("riskyEnableConfirm")),
							el("button", { type: "button", className: styles.toggle, onClick: () => setRiskyConfirm(null) }, t("riskyEnableCancel"))))
					: null,
				el("div", { className: styles.marketHead },
					el("h3", null, mode === "skills"
						? (searchSource === "github"
							? t("skillsMarketTitle")
							: t("skillsMarketTitleOther").replace("{source}", sourceDisplayName(searchSource)))
						: (searchSource === "github"
							? t("marketTitle")
							: t("marketTitleOther").replace("{source}", sourceDisplayName(searchSource)))),
					el("div", { id: "pc-ghwrap", className: styles.ghwrap },
selfUpdate !== null ? el("button", {
type: "button",
className: styles.ghpill,
title: t("hubUpdateAvailable") + " v" + selfUpdate.latest,
onClick: () => {
setMessage(t("installing"));
call("/plugin-console/self-update", {}).then(
(data) => {
if (data && data.ok === true) {
// 未写进 lockfile 时必须**显眼**说清（用户实测报告：只铺文件不写 lock → 之后任何 pnpm 操作
// 都会把版本还原，而用户以为升级成功了）
const lockWarn = data.lockUpdated === false && typeof data.lockNote === "string" && data.lockNote !== ""
? "⚠️ " + data.lockNote
: "";
setMessage((data.note ?? "已更新") + (lockWarn === "" ? "" : "。" + lockWarn) + "，正在重启生效…");
call("/plugin-console/restart", {}).then(() => {}, () => {});
} else {
setMessage(t("failed") + "：" + (data?.reason ?? "未知"));
}
},
(error) => setMessage(t("failed") + "：" + friendlyGithubError(error).message),
);
}
}, "⬇ " + t("hubUpdateAvailable") + " v" + selfUpdate.latest) : null,
						el("button", {
							type: "button",
							className: styles.ghpill,
							// 外观回退：市场页只有**这一颗** pill，登录态体现在它的绿色描边上（data-on），
							// 不再单独占一颗登录徽章
							"data-on": ghAuthed ? "true" : "false",
							title: t("searchSourceTitle"),
							"aria-label": t("searchSourceTitle"),
							onClick: () => setSourceMenuOpen((v) => !v),
						},
							// 源选在 GitHub 时这颗 pill 顺手报登录态（回到上一批之前的形态）；
							// 选别的源时只报源名 —— 否则"未登录 GitHub"看着像徽章却点开的是源菜单
							searchSource === "github"
								? (ghAuthed ? t("githubLoggedIn") + ghLoginName : t("githubCornerOut"))
								: t("sourceOf") + ((searchSourcesList !== null ? searchSourcesList.find((s) => s.id === searchSource)?.name : undefined)
									?? (searchSource === "gitee" ? "Gitee" : searchSource)),
							" ▾"),
						sourceMenuOpen
							? el("div", { className: styles.sourceMenu },
								(searchSourcesList !== null && searchSourcesList.length > 0
									? searchSourcesList
									: [{ id: "github", name: "GitHub" }, { id: "gitee", name: "Gitee" }]
								).map((s) =>
									el("button", {
										type: "button",
										key: s.id,
										className: styles.sourceOpt,
										"data-active": searchSource === s.id ? "true" : "false",
										onClick: () => {
											setSearchSource(s.id);
											try { localStorage.setItem("pc-search-source", s.id); } catch {}
											setSourceMenuOpen(false);
										},
									}, s.name)),
								// ── 登录区（登录入口收进这颗 pill 的菜单里，不再单独一颗徽章）──
								el("div", { style: { height: 1, margin: "4px 2px", background: "var(--dsw-alias-border-l2)" } }),
								ghAuthed
									// 已登录：这行只报状态（点了把状态念到消息栏，不做别的）
									? el("button", {
										type: "button",
										className: styles.sourceOpt,
										"data-active": "true",
										title: t("githubLoginTip"),
										onClick: () => setMessage(t("githubLoggedIn") + ghLoginName),
									}, t("githubLoggedIn") + ghLoginName)
									// 未登录：主入口走设备码窗口登录；窗口不可用时它自己会展开下面的 token 子面板
									: el("button", {
										type: "button",
										className: styles.sourceOpt,
										disabled: ghLoginBusy,
										title: t("githubLoginTip"),
										onClick: githubOpenLogin,
									}, t("githubLoginViaApp")),
								// 次要入口：token 兜底（已登录时也留着 —— 换账号/换 token 就靠它）
								el("button", {
									type: "button",
									className: styles.sourceOpt,
									onClick: () => setGhLoginOpen((v) => !v),
								}, t("githubLoginOrToken")),
								// token 兜底子面板：窗口登录不可用（插件没装/非 Windows/没有 exe）时自动展开；
								// 也可以从上面「或用 Token 登录」主动开合。样式内联，不为它改 CSS 表。
								ghLoginOpen
									? el("div", { style: { display: "flex", flexDirection: "column", gap: 6, width: 280, boxSizing: "border-box", padding: "2px 2px 4px" } },
										el("p", { className: styles.message, style: { margin: 0 } }, t("githubLoginTip")),
										el("input", {
											type: "password",
											placeholder: t("githubTokenPlaceholder"),
											value: ghToken,
											onChange: (event) => setGhToken(event.currentTarget.value),
											style: { width: "100%", boxSizing: "border-box" },
										}),
										el("button", { type: "button", className: styles.toggle, disabled: ghLoginBusy || ghToken.trim() === "", onClick: githubLogin }, t("githubLoginBtn")))
									: null)
							: null,
					)),
				(aiRunning || aiJobsList.some((x) => x.status === "running"))
					? el("button", {
						type: "button",
						className: styles.aiSpinBtn,
						title: t("aiProgressTitle"),
						"aria-label": t("aiProgressTitle"),
						onClick: () => setAiOpen(true),
					}, el("div", { className: styles.aiSpinner }))
					: null,
				el("button", {
					type: "button",
					className: styles.toolbarMain,
					"data-active": toolbarOpen ? "true" : "false",
					title: t(toolbarOpen ? "toolbarCloseTitle" : "toolbarOpenTitle"),
					"aria-label": t("toolbarLabel"),
					style: (dragPos ?? toolbarPos) !== null
						? { left: (dragPos ?? toolbarPos).left, top: (dragPos ?? toolbarPos).top, right: "auto", touchAction: "none", userSelect: "none" }
						: { touchAction: "none", userSelect: "none" },
					onPointerDown: (e) => {
						const cur = dragPos ?? toolbarPos ?? { left: Math.max(8, window.innerWidth - 70 - 110), top: 20 };
						dragRef.current.grabX = e.clientX - cur.left;
						dragRef.current.grabY = e.clientY - cur.top;
						dragRef.current.base = cur;
						dragRef.current.active = false;
						dragRef.current.justDragged = false;
						try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
						dragRef.current.long = window.setTimeout(() => {
							dragRef.current.active = true;
							setDragPos(cur);
						}, 450);
					},
					onPointerMove: (e) => {
						if (!dragRef.current.active) return;
						const w = window.innerWidth;
						const h = window.innerHeight;
						const bw = e.currentTarget.offsetWidth || 96;
						const bh = e.currentTarget.offsetHeight || 30;
						const left = Math.max(8, Math.min(w - bw - 8, e.clientX - dragRef.current.grabX));
						const top = Math.max(8, Math.min(h - bh - 8, e.clientY - dragRef.current.grabY));
						setDragPos({ left, top });
					},
					onPointerUp: () => {
						if (dragRef.current.long !== null) { window.clearTimeout(dragRef.current.long); dragRef.current.long = null; }
						if (dragRef.current.active) {
							const p = dragPos;
							if (p !== null) {
								try { localStorage.setItem("pc-toolbar-pos", JSON.stringify(p)); } catch {}
								setToolbarPos(p);
							}
							dragRef.current.active = false;
							dragRef.current.justDragged = true;
							window.setTimeout(() => { dragRef.current.justDragged = false; }, 300);
							setDragPos(null);
						}
					},
					onPointerCancel: () => {
						if (dragRef.current.long !== null) { window.clearTimeout(dragRef.current.long); dragRef.current.long = null; }
						dragRef.current.active = false;
						setDragPos(null);
					},
					onClick: (e) => {
						if (dragRef.current.justDragged) { e.preventDefault(); dragRef.current.justDragged = false; return; }
						setToolbarOpen((v) => {
							const next = !v;
							try { localStorage.setItem("pc-toolbar-open", next ? "1" : "0"); } catch {}
							return next;
						});
					},
				}, t("toolbarLabel") + (toolbarOpen ? " ▾" : " ▸")),
				toolbarOpen
					? el("div", { className: styles.toolbarGroup, style: (dragPos ?? toolbarPos) !== null ? { left: (dragPos ?? toolbarPos).left, top: (dragPos ?? toolbarPos).top + 36, right: "auto" } : undefined },
						el("button", {
							type: "button",
							className: styles.toolItem,
							title: t("restartService"),
							onClick: () => { setMessage(t("restarting")); call("/plugin-console/restart", {}).then(() => { window.setTimeout(() => window.location.reload(), 12000); }, () => {}); },
						}, t("restartService")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-active": repoLandOn ? "true" : "false",
							title: repoLandTitleText(),
							"aria-label": t("repoLandLabel"),
							onClick: () => { setRepoLandOn((v) => { const n = !v; try { localStorage.setItem("pc-repo-land", n ? "1" : "0"); } catch {} return n; }); setRepoLandOpen(true); repoLandRefresh(); },
						}, t("repoLandLabel")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-active": aiFallback ? "true" : "false",
							title: t("aiFallbackTitle"),
							"aria-label": t("aiFallbackLabel"),
							onClick: () => setAiFallback((v) => {
								const next = !v;
								try { localStorage.setItem("pc-ai-fallback-v2", next ? "on" : "off"); } catch {}
								return next;
							}),
						}, t("aiFallbackLabel")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-busy": aiRunning ? "true" : "false",
							"data-active": aiOpen ? "true" : "false",
							title: t("aiEmpowerTitle"),
							"aria-label": t("aiEmpowerLabel"),
							onClick: () => setAiOpen((v) => !v),
						}, t("aiEmpowerLabel")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							title: t("sourcesTitle"),
							"aria-label": t("sourcesBtn"),
							onClick: openSources,
						}, t("sourcesBtn")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-active": gateOpen ? "true" : "false",
							title: t("gateTitle"),
							"aria-label": t("gateBtn"),
							onClick: () => setGateOpen((v) => !v),
						}, t("gateBtn") + (gatePendingCount > 0 ? " " + gatePendingCount : "")),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-active": fwPanelOpen ? "true" : "false",
							"data-mode": fwRunning ? "true" : "false",
							title: t("fwPanelTitle"),
							"aria-label": t("fwPanelBtn"),
							onClick: () => {
								setFwPanelOpen((v) => {
									const next = !v;
									// 打开时拉一次真实状态（无视卡片的「已关闭」标记）+ 版本检查
									if (next) { fwStatusRefresh(); if (fwCheck === null) fwCheckRefresh(false); }
									return next;
								});
							},
						}, t("fwPanelBtn") + fwBadge),
						el("button", {
							type: "button",
							className: styles.toolItem,
							"data-mode": mode === "skills" ? "true" : "false",
							title: t("modeBtn"),
							"aria-label": t("modeBtn"),
							onClick: () => {
								const next = mode === "plugins" ? "skills" : "plugins";
								setMode(next);
								try { localStorage.setItem("pc-market-mode", next); } catch {}
								setMarket(null);
							},
						}, (mode === "skills" ? t("pluginsMode") : t("skillsMode"))))
					: null,
				market !== null && market.status === "ready" && market.data.length > 0
					? el("div", { className: styles.backTopWrap },
						showBackTop
							? el("button", {
								type: "button",
								className: styles.backTop,
								title: t("backToSearch"),
								"aria-label": t("backToSearch"),
								onClick: () => {
									const node = document.getElementById("pc-market-search");
									if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
								},
							}, el("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" },
								el("polyline", { points: "18 15 12 9 6 15" })))
							: null,
						el("button", {
							type: "button",
							className: styles.backTop,
							title: marketCollapsed ? t("expandResults") : t("collapseResults"),
							"aria-label": marketCollapsed ? t("expandResults") : t("collapseResults"),
							onClick: () => setMarketCollapsed((v) => !v),
						}, el("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" },
							marketCollapsed
								? [el("polyline", { key: "a", points: "6 9 12 15 18 9" }), el("polyline", { key: "b", points: "6 16 12 22 18 16" })]
								: [el("polyline", { key: "a", points: "18 15 12 9 6 15" }), el("polyline", { key: "b", points: "18 8 12 2 6 8" })])))
					: null,
				el("p", { className: styles.note }, mode === "skills"
					? (searchSource === "github"
						? t("skillsNote")
						: t("skillsGithubOnly"))
					: (searchSource === "github" ? t("direct") : t("directOther").replace("{source}", sourceDisplayName(searchSource)))),
				indexData !== null && indexData.offline === true
					? el("p", { className: styles.message, "data-warn": "true" },
						t("marketIndexOffline").replace("{time}", indexData.cachedAt !== null ? new Date(indexData.cachedAt).toLocaleString() : "—")
						+ (indexData.sourceName !== null ? " · " + t("marketIndexFrom").replace("{source}", indexData.sourceName) : ""))
					: null,
				// 索引彻底没加载成功：说清后果（只剩 GitHub 实时结果）+ 给重试入口。
				// 2026-09-20 事故：这种状态下"包名/README/子包里的名字"搜不到，而界面上只有一句加载失败
				indexData === null && indexError !== null
					? el("p", { className: styles.message, "data-warn": "true" },
						t("marketIndexStale") + " ",
						el("button", {
							type: "button",
							className: styles.toggle,
							onClick: () => loadMarketIndex(),
						}, t("marketIndexRetry")))
					: null,
				el("div", { className: styles.search, id: "pc-market-search" },
					el("div", { className: styles.searchInner },
						el("input", {
							type: "search",
							value: query,
							placeholder: mode === "skills"
								? (searchSource === "github"
									? t("skillsSearchPlaceholder")
									: t("skillsGithubOnly"))
								: (searchSource === "github"
									? t("searchPlaceholder")
									: searchSource === "gitee"
										? t("giteeRepoPlaceholder")
										: t("searchPlaceholderOther").replace("{source}", sourceDisplayName(searchSource))),
							"aria-label": t("search"),
							onChange: (event) => {
								const v = event.currentTarget.value;
								setQuery(v);
								try { localStorage.setItem("pc-market-query", v); } catch {}
							},
							onKeyDown: (event) => { if (event.key === "Enter") search(); },
						}),
					),
					mode === "plugins"
						? el("button", {
							type: "button",
							className: styles.starBtn,
							"data-active": officialOnly ? "true" : "false",
							title: t("officialTitle"),
							"aria-label": t("officialOnlyToggle"),
							onClick: () => setOfficialOnly((v) => {
								const next = !v;
								try { localStorage.setItem("pc-market-official", next ? "1" : "0"); } catch {}
								return next;
							}),
						}, officialOnly ? "★" : "☆")
						: null,
					mode === "plugins"
						? el("button", {
							type: "button",
							className: styles.starBtn,
							"data-active": multiSource ? "true" : "false",
							title: t("multiSourceTitle"),
							"aria-label": t("multiSourceToggle"),
							onClick: () => setMultiSource((v) => {
								const next = !v;
								try { localStorage.setItem("pc-multi-source", next ? "1" : "0"); } catch {}
								return next;
							}),
						}, multiSource ? "⊞" : "⊟")
						: null,
					el("button", { type: "button", onClick: search }, t("search")),
				),
				!marketCollapsed && marketRows.length > 0 ? el("ul", { className: styles.market }, marketRows) : null,
				!marketCollapsed && market !== null && market.status === "ready" && market.data.length >= 20
					? el("div", { className: styles.descTopbar },
						el("button", {
							type: "button",
							className: styles.toggle,
							disabled: loadingMore,
							onClick: loadMore,
						}, loadingMore ? t("loadingMore") : t("loadMore")))
					: null,
				Object.values(jobs).filter((job) => job.status === "installing").map((job) => {
					if (job.stage === "ai-consent") {
						// 授权请求就摆在**安装进度所在位置**（用户盯着进度看，授权提示不能只在模态框里）。
						// 这块卡片是要显眼的：警告色描边 + 倒计时 + 同意/取消，而不是一行小字。
						// 关掉兜底或勾了"不再提醒"时给出对应说明（这两种情况前端会自动同意/取消）。
						const autoNote = !aiFallback ? t("aiFallbackOff") : (aiRemember ? t("aiRememberNote") : null);
						const remain = consentRemaining(job);
						const lastError = job.aiConsent?.lastError ?? null;
						const progressLine = progressText(job.progress);
						return el("div", { key: job.jobId, className: styles.consentCard },
							el("div", { className: styles.rowTop },
								el("span", { className: styles.spinner }),
								el("strong", { className: styles.name }, t("aiConsentCardTitle")),
								remain !== null ? el("span", { className: styles.consentCountdown }, t("aiConsentCountdown") + " " + remain) : null),
							el("p", { className: styles.message }, t("installingLocal") + "：" + (job.packageName ?? job.repo)),
							progressLine !== "" ? el("p", { className: styles.progress }, progressLine) : null,
							el("p", { className: styles.message }, t("aiConsentText")),
							lastError !== null ? el("p", { className: styles.note }, t("aiConsentLastError") + "：" + lastError) : null,
							remain !== null ? el("p", { className: styles.note }, t("aiConsentTimeoutNote").replace("{min}", consentTimeoutMinutes(job))) : null,
							autoNote !== null ? el("p", { className: styles.note }, autoNote) : null,
							el("div", { className: styles.rowTop },
								el("button", { type: "button", className: styles.consentApprove, onClick: () => aiConsent(job.jobId, true) }, t("aiConsentApprove")),
								el("button", { type: "button", className: styles.toggle, onClick: () => aiConsent(job.jobId, false) }, t("aiConsentDecline"))));
					}
					const stageKey = job.stage === "preparing" ? "stagePreparing" : job.stage === "configuring" ? "stageConfiguring" : job.stage === "repairing" ? "stageRepairing" : "stageInstalling";
					const elapsed = Math.max(0, Math.round((Date.now() - (job.startedAt ?? Date.now())) / 1000));
					const progressLine = progressText(job.progress);
					return el("div", { key: job.jobId, className: styles.detail },
						el("div", { className: styles.rowTop },
							el("span", { className: styles.spinner }),
							el("strong", { className: styles.name }, t("installingLocal") + "：" + (job.packageName ?? job.repo))),
						progressLine !== "" ? el("p", { className: styles.progress }, progressLine) : null,
						el("p", { className: styles.status },
							t("stageLabel") + "：" + t(stageKey) + " · " + t("elapsed") + " " + elapsed + "s"));
				}),
				Object.entries(suiteReports).map(([jobId, report]) =>
					el("div", { key: "suite-" + jobId, className: styles.detail },
						el("p", { className: styles.status }, t("suiteComponentType") + "："),
						el("ul", { className: styles.market }, report.map((r) =>
							el("li", { key: r.component, className: styles.item },
								el("div", { className: styles.itemTop },
									el("code", { className: styles.name }, r.component),
									r.ok
										? el("span", { className: styles.tag, "data-user": "true" }, t("suiteComponentOk"))
										: el("span", { className: styles.tag, "data-error": "true" }, t("suiteComponentFail"))),
								r.note ? el("p", { className: styles.desc }, r.note) : null))))),
				(state.status === "ready" ? state.data.recentFailures ?? [] : []).filter((job) => !dismissedFailures[job.jobId]).map((job) =>
					el("div", { key: "fail-" + job.jobId, className: styles.detail },
						el("div", { className: styles.rowTop },
							el("span", { className: styles.phase, "data-phase": "failed" }, t("recentFailures")),
							el("strong", { className: styles.name }, job.packageName ?? job.repo),
							el("button", {
								type: "button",
								className: styles.trashBtn,
								title: t("dismissFailure"),
								"aria-label": t("dismissFailure"),
								onClick: () => setDismissedFailures((prev) => ({ ...prev, [job.jobId]: true })),
							}, "✕")),
						el("p", { className: styles.message, "data-error": "true" }, job.error ?? ""),
						el("div", { className: styles.rowTop },
							el("button", { type: "button", className: styles.toggle, onClick: () => startJob(job.repo, job.packageName, job.source ?? "github") }, t("retry")),
							job.hint === "repo-land"
								? el("button", { type: "button", className: styles.toggle, title: repoLandTitleText(), onClick: () => { setRepoLandOpen(true); repoLandEntry(job.repo); } }, t("repoLandEntry"))
								: null)),
				),
				repoInfo !== null
					? el("aside", { className: styles.floatPanel },
						el("div", { className: styles.descTopbar },
							el("button", { type: "button", className: styles.toggle, onClick: () => setRepoInfo(null) }, "✕")),
						detail)
					: null,
				el("div", { id: "pc-installed-search-area" },
					el("div", { className: styles.installedHead },
						el("h3", null, mode === "skills" ? t("installedSkillsTitle") : t("installedTitle")),
						mode === "plugins"
							? el("button", { type: "button", className: styles.toggle, onClick: () => setInstalledSearchOpen((v) => !v) }, t("search"))
							: null),
					mode === "plugins" && installedSearchOpen
						? el("div", { className: styles.search },
							el("input", {
								type: "search",
								id: "pc-installed-search-input",
								value: installedQuery,
								placeholder: t("searchInstalledPlaceholder"),
								"aria-label": t("searchInstalledPlaceholder"),
								onChange: (event) => {
									const v = event.currentTarget.value;
									setInstalledQuery(v);
									try { localStorage.setItem("pc-market-installed-q", v); } catch {}
								},
							}),
							el("button", {
								type: "button",
								className: styles.extraBtn,
								"data-flash": extraFlash ? "true" : "false",
								title: t("extraFilterTitle"),
								"aria-label": t("extraFilterTitle"),
								onClick: () => {
									setExtraOnly((v) => !v);
									setExtraFlash(true);
									window.setTimeout(() => setExtraFlash(false), 1500);
								},
							}, extraOnly ? t("extraFilterAll") : t("extraFilter") + " · " + extraCount),
							)
						: null),
				mode === "skills"
					? (installedSkills.length === 0 && pluginSkills.length === 0
						? el("p", { className: styles.status, "data-error": "false" }, t("skillsEmpty") + "。" + t("skillsEmptyHint"))
						: el("div", { style: { flexDirection: "column", gap: 8, display: "flex" } },
							pluginSkills.length > 0
								? el("div", { className: styles.detail },
									el("strong", { className: styles.name }, t("pluginSkillsTitle") + "（" + pluginSkills.length + "）"),
									el("p", { className: styles.status }, t("pluginSkillsHint")),
									el("ul", { className: styles.list }, pluginSkills.map((sk) =>
										el("li", { key: sk.name, className: styles.row },
											el("div", { className: styles.rowTop },
												el("code", { className: styles.name }, sk.name),
												el("span", { className: styles.tag, "data-system": "true" }, t("pluginSkillTag") + (sk.provider ? " · " + sk.provider : ""))),
											sk.description ? el("p", { className: styles.desc }, sk.description) : null))))
								: null,
							installedSkills.length > 0
								? el("ul", { className: styles.list }, installedSkills.map((sk) =>
							el("li", { key: sk.name, className: styles.row },
								el("div", { className: styles.rowTop },
									el("code", { className: styles.name }, sk.name),
									sk.system === true
										? el("span", { className: styles.tag, "data-system": "true", title: t("skillSystemTitle") }, t("skillSystemTag"))
										: sk.disabled === true
											? el("span", { className: styles.tag, "data-disabled": "true", title: t("skillDisabledTitle") }, t("skillDisabledTag"))
											: el("span", { className: styles.tag, "data-skill": "true", title: t("skillTitle") }, t("skillBadge"))),
								el("div", { className: styles.meta }, sk.path ?? ""),
								el("div", { className: styles.rowTop },
									sk.system === true
										? null
										: el("button", {
											type: "button",
											className: styles.toggle,
											disabled: togglingSkill === sk.name,
											onClick: () => doToggleSkill(sk.name, sk.disabled === true),
										}, togglingSkill === sk.name ? t("installingLocal") : (sk.disabled === true ? t("skillEnable") : t("skillDisable"))),
									sk.system === true
										? null
										: confirmSkillDelete === sk.name
											? el("button", {
												type: "button",
												className: styles.toggle,
												onClick: () => doRemoveSkill(sk.name),
											}, t("skillDeleteConfirm").replace("{name}", sk.name))
											: el("button", {
												type: "button",
												className: styles.trashBtn,
												title: t("skillDelete"),
												"aria-label": t("skillDelete"),
												onClick: () => setConfirmSkillDelete(sk.name),
											}, "✕")))))
								: null))
					: (state.status === "loading"
						? el("p", { className: styles.status }, t("loading"))
						: state.status === "error"
							? el("div", { className: styles.detail },
								el("p", { className: styles.status, "data-error": "true" }, t("error")),
								el("button", { type: "button", className: styles.toggle, onClick: refresh }, t("retry")))
							: state.data.entries.length === 0 && pendingCards.length === 0
								? el("p", { className: styles.status }, t("empty"))
								: installedQueryNorm !== "" && rows.length === 0
									? el("p", { className: styles.status }, t("noMatch"))
									: extraOnly && rows.length === 0
										? el("p", { className: styles.status }, t("extraEmpty"))
										: el("ul", { className: styles.list }, rows)),
				showBackTop
					? el("button", {
						type: "button",
						className: styles.refresh,
						title: t("refreshList"),
						"aria-label": t("refreshList"),
						onClick: refresh,
					}, el("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" },
						el("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
						el("polyline", { points: "21 3 21 9 15 9" })))
					: null,
				aiRemember
					? el("div", { className: styles.descTopbar },
						el("button", {
							type: "button",
							className: styles.toggle,
							onClick: () => {
								setAiRemember(false);
								try { localStorage.setItem("pc-ai-remember", "0"); } catch {}
								setMessage(t("aiRememberReset"));
							},
						}, t("aiRememberReset")))
					: null,
				(() => {
					// 最上层模态框：需要 AI 兜底授权时无论如何都让用户看到
					const consentJob = Object.values(jobs).find((job) => job.status === "installing" && job.stage === "ai-consent" && aiFallback && !aiRemember);
					if (consentJob === undefined) return null;
					// 倒计时与进度也放进模态框：用户在模态框上做决定，不用回去翻进度区
					const remain = consentRemaining(consentJob);
					const lastError = consentJob.aiConsent?.lastError ?? null;
					const progressLine = progressText(consentJob.progress);
					return el("div", { className: styles.modalBackdrop },
						el("div", { className: styles.modalCard },
							el("strong", { className: styles.name }, t("aiConsentCardTitle")),
							el("p", { className: styles.message }, t("installingLocal") + "：" + (consentJob.packageName ?? consentJob.repo)),
							progressLine !== "" ? el("p", { className: styles.progress }, progressLine) : null,
							remain !== null
								? el("p", { className: styles.message, "data-warn": "true" },
									t("aiConsentCountdown") + " " + remain + " · " + t("aiConsentTimeoutNote").replace("{min}", consentTimeoutMinutes(consentJob)))
								: null,
							el("p", { className: styles.message }, t("aiConsentText")),
							lastError !== null ? el("p", { className: styles.note }, t("aiConsentLastError") + "：" + lastError) : null,
							el("label", { className: styles.consentRemember },
								el("input", {
									type: "checkbox",
									checked: aiRemember,
									onChange: (event) => {
										const checked = event.currentTarget.checked;
										setAiRemember(checked);
										try { localStorage.setItem("pc-ai-remember", checked ? "1" : "0"); } catch {}
									},
								}),
								t("aiConsentRemember")),
							el("div", { className: styles.rowTop },
								el("button", { type: "button", className: styles.consentApprove, onClick: () => { try { localStorage.setItem("pc-ai-remember", aiRemember ? "1" : "0"); } catch {} aiConsent(consentJob.jobId, true); } }, t("aiConsentApprove")),
								el("button", { type: "button", className: styles.toggle, onClick: () => aiConsent(consentJob.jobId, false) }, t("aiConsentDecline")))));
				})(),
				sourcesOpen
					? el("div", { className: styles.modalBackdrop },
						el("div", { className: styles.modalCard },
							el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
								el("strong", { className: styles.name }, t("sourcesTitle")),
								el("button", { type: "button", className: styles.trashBtn, style: { fontSize: 14, padding: "4px 8px" }, title: t("closeModal"), "aria-label": t("closeModal"), onClick: () => setSourcesOpen(false) }, "✕")),
							el("p", { className: styles.message }, t("sourcesDesc")),
							sourcesData === null
								? el("p", { className: styles.status }, t("loading"))
								: el("div", { className: styles.accWrap },
									accSection("registries", t("sourcesBtn"), [
									...sourcesData.registries.map((src) =>
										editReg !== null && editReg.id === src.id
											? el("div", { key: src.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("input", { type: "text", value: editReg.name, onChange: (event) => setEditReg({ ...editReg, name: event.currentTarget.value }), style: { flex: 1, minWidth: 80 } }),
												el("input", { type: "text", value: editReg.url, onChange: (event) => setEditReg({ ...editReg, url: event.currentTarget.value }), style: { flex: 2, minWidth: 120 } }),
												el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: saveEditReg }, t("saveSource")),
												el("button", { type: "button", className: styles.toggle, onClick: () => setEditReg(null) }, t("cancelEdit")))
											: el("div", { key: src.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("div", { className: styles.rowTop, style: { flex: 1, minWidth: 0 } },
													el("strong", { className: styles.name, style: { flex: "none", maxWidth: "35%" } }, src.name + (src.primary ? "（" + t("sourcePrimary") + "）" : "")),
													el("code", { className: styles.srcUrl }, src.url),
													(() => {
														const hit = scanOf(src.id);
														if (hit === null) return null;
														const title = hit.ok === true
															? hit.url + " · " + hit.ms + "ms" + (hit.versions !== null ? " · " + hit.versions + " 个版本" : "") + (hit.latest === null ? " · " + t("registryScanNoVersion") : "")
															: hit.url + " · " + (hit.error ?? t("registryScanFail")) + " · " + hit.ms + "ms";
														return el("span", {
															className: styles.tag,
															"data-enabled": hit.ok === true ? "true" : undefined,
															"data-bad": hit.ok === true ? undefined : "true",
															title,
														}, hit.ok === true
															? "✓ " + hit.ms + "ms" + (hit.latest !== null ? " · v" + hit.latest : " · " + t("registryScanNoVersion"))
															: "✗ " + (hit.error ?? t("registryScanFail")));
													})()),
												el("div", { className: styles.rowTop },
													src.primary ? null : el("button", { type: "button", className: styles.toggle, title: t("setPrimaryHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "set-primary", id: src.id }) }, t("setPrimary")),
													el("button", { type: "button", className: styles.toggle, title: t("editSourceHint"), disabled: sourcesBusy, onClick: () => setEditReg({ id: src.id, name: src.name, url: src.url }) }, t("editSource"))))),
									el("div", { className: styles.rowTop },
										el("input", { type: "text", placeholder: t("sourceName"), value: sourceName, onChange: (event) => setSourceName(event.currentTarget.value), style: { flex: 1, minWidth: 0 } }),
										el("input", { type: "text", placeholder: t("sourceUrl"), value: sourceUrl, onChange: (event) => setSourceUrl(event.currentTarget.value), style: { flex: 2, minWidth: 0 } }),
										el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: addSource }, t("addSource"))),
									el("div", { className: styles.rowTop },
										el("button", {
											type: "button",
											className: styles.toggle,
											title: t("registryScanHint"),
											disabled: regScan !== null && regScan.status === "scanning",
											onClick: scanRegistries,
										}, regScan !== null && regScan.status === "scanning" ? t("registryScanning") : t("registryScan")),
										regScan !== null && regScan.status === "scanning" ? el("span", { className: styles.spinner }) : null,
										regScan !== null && regScan.status === "ready"
											? el("span", { className: styles.message },
												t("registryScanSummary").replace("{ok}", String(scanOkCount)).replace("{total}", String(scanRows.length))
												+ (scanBest !== null ? " · " + t("registryScanBest").replace("{version}", scanBest.latest).replace("{name}", scanBest.name) : ""))
											: null),
									]),
									accSection("index", t("indexSourcesTitle"), [
									el("p", { className: styles.message }, t("indexSourcesDesc")),
									(sourcesData.indexSources ?? []).map((s) =>
										editIndex !== null && editIndex.id === s.id
											? el("div", { key: s.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("input", { type: "text", value: editIndex.name, onChange: (event) => setEditIndex({ ...editIndex, name: event.currentTarget.value }), style: { flex: 1, minWidth: 80 } }),
												el("input", { type: "text", value: editIndex.url, onChange: (event) => setEditIndex({ ...editIndex, url: event.currentTarget.value }), style: { flex: 2, minWidth: 120 } }),
												el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: saveEditIndex }, t("saveSource")),
												el("button", { type: "button", className: styles.toggle, onClick: () => setEditIndex(null) }, t("cancelEdit")))
											: el("div", { key: s.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("div", { className: styles.rowTop, style: { flex: 1, minWidth: 0 } },
													el("strong", { className: styles.name, style: { flex: "none", maxWidth: "35%" } }, s.name + (s.primary ? "（" + t("sourcePrimary") + "）" : "")),
													el("code", { className: styles.srcUrl }, s.url)),
												el("div", { className: styles.rowTop },
													s.primary ? null : el("button", { type: "button", className: styles.toggle, title: t("setPrimaryHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "set-index-primary", id: s.id }) }, t("setPrimary")),
													el("button", { type: "button", className: styles.toggle, title: t("editSourceHint"), disabled: sourcesBusy, onClick: () => setEditIndex({ id: s.id, name: s.name, url: s.url }) }, t("editSource")),
													el("button", { type: "button", className: styles.toggle, title: t("removeSourceHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "remove-index", id: s.id }) }, t("removeSource"))))),
									el("div", { className: styles.rowTop },
										el("input", { type: "text", placeholder: t("sourceName"), value: indexSourceName, onChange: (event) => setIndexSourceName(event.currentTarget.value), style: { flex: 1, minWidth: 0 } }),
										el("input", { type: "text", placeholder: t("indexUrlPlaceholder"), value: indexSourceUrl, onChange: (event) => setIndexSourceUrl(event.currentTarget.value), style: { flex: 2, minWidth: 0 } }),
										el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: addIndexSource }, t("addIndexSource"))),
									el("div", { className: styles.rowTop },
										el("button", {
											type: "button",
											className: styles.toggle,
											"data-active": sourcesData.indexMerge === true ? "true" : "false",
											title: t("indexMergeDesc"),
											disabled: sourcesBusy,
											onClick: () => sourcesAction({ action: "set-index-merge", merge: sourcesData.indexMerge !== true }),
										}, t("indexMergeLabel") + "：" + (sourcesData.indexMerge === true ? t("on") : t("off")))),
									el("p", { className: styles.message }, t("indexMergeDesc")),
									]),
									accSection("git", t("gitSourcesTitle"), [
									el("p", { className: styles.message }, t("gitSourcesDesc")),
									(sourcesData.gitSources ?? []).map((s) =>
										editGit !== null && editGit.id === s.id
											? el("div", { key: s.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("input", { type: "text", value: editGit.name, onChange: (event) => setEditGit({ ...editGit, name: event.currentTarget.value }), style: { flex: 1, minWidth: 80 } }),
												el("input", { type: "text", value: editGit.urlTemplate, onChange: (event) => setEditGit({ ...editGit, urlTemplate: event.currentTarget.value }), style: { flex: 2, minWidth: 120 } }),
												el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: saveEditGit }, t("saveSource")),
												el("button", { type: "button", className: styles.toggle, onClick: () => setEditGit(null) }, t("cancelEdit")))
											: el("div", { key: s.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
												el("div", { className: styles.rowTop, style: { flex: 1, minWidth: 0 } },
													el("strong", { className: styles.name, style: { flex: "none", maxWidth: "35%" } }, s.name + (s.primary ? "（" + t("sourcePrimary") + "）" : "")),
													el("code", { className: styles.srcUrl }, s.urlTemplate)),
												el("div", { className: styles.rowTop },
													s.primary ? null : el("button", { type: "button", className: styles.toggle, title: t("setPrimaryHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "set-git-primary", id: s.id }) }, t("setPrimary")),
													el("button", { type: "button", className: styles.toggle, title: t("editSourceHint"), disabled: sourcesBusy, onClick: () => setEditGit({ id: s.id, name: s.name, urlTemplate: s.urlTemplate }) }, t("editSource")),
													el("button", { type: "button", className: styles.toggle, title: t("removeSourceHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "remove-git", id: s.id }) }, t("removeSource"))))),
									el("div", { className: styles.rowTop },
										el("input", { type: "text", placeholder: t("sourceName"), value: gitSourceName, onChange: (event) => setGitSourceName(event.currentTarget.value), style: { flex: 1, minWidth: 0 } }),
										el("input", { type: "text", placeholder: t("gitUrlPlaceholder"), value: gitSourceUrl, onChange: (event) => setGitSourceUrl(event.currentTarget.value), style: { flex: 2, minWidth: 0 } }),
										el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: addGitSource }, t("addGitSource"))),
									]),
									accSection("search", t("searchSourcesTitle"), [
									el("p", { className: styles.message }, t("searchSourcesDesc")),
									(sourcesData.searchSources ?? []).map((s) =>
										el("div", { key: s.id, className: styles.rowTop, style: { justifyContent: "space-between" } },
											el("div", { className: styles.rowTop, style: { flex: 1, minWidth: 0 } },
												el("strong", { className: styles.name, style: { flex: "none", maxWidth: "35%" } }, s.name),
												s.type === "custom" ? el("code", { className: styles.srcUrl }, s.url) : el("span", { className: styles.tag }, "内置"),
												s.type === "custom" && s.headers !== undefined && Object.keys(s.headers).length > 0
													? el("span", { className: styles.tag, title: t("headersPlaceholder") }, "🔒 " + Object.keys(s.headers).length)
													: null),
											s.type === "custom"
												? el("button", { type: "button", className: styles.toggle, title: t("removeSourceHint"), disabled: sourcesBusy, onClick: () => sourcesAction({ action: "remove-search", id: s.id }) }, t("removeSource"))
												: null)),
									el("div", { className: styles.rowTop },
										el("input", { type: "text", placeholder: t("sourceName"), value: searchSourceName, onChange: (event) => setSearchSourceName(event.currentTarget.value), style: { flex: 1, minWidth: 0 } }),
										el("input", { type: "text", placeholder: t("searchUrlPlaceholder"), value: searchSourceUrl, onChange: (event) => setSearchSourceUrl(event.currentTarget.value), style: { flex: 2, minWidth: 0 } }),
										el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: addSearchSource }, t("addSearchSource"))),
									el("textarea", {
										rows: 2,
										placeholder: t("headersPlaceholder"),
										value: searchSourceHeaders,
										onChange: (event) => setSearchSourceHeaders(event.currentTarget.value),
										style: { width: "100%", boxSizing: "border-box", font: "inherit", resize: "vertical" },
									}),
									]),
									accSection("gitee", t("giteeTitle"), [
									el("p", { className: styles.message }, t("giteeDesc").replace("{port}", String(window.location.port || "3080"))),
									el("div", { className: styles.rowTop, style: { justifyContent: "space-between" } },
										el("span", { className: styles.tag },
											giteeStatus !== null && giteeStatus.hasToken
												? t("giteeLoggedIn") + (giteeStatus.login || "—")
												: (giteeStatus !== null && giteeStatus.clientConfigured ? t("giteeSetupHint") : t("giteeLoginPrompt")))),
									el("div", { className: styles.rowTop },
										el("input", { type: "text", placeholder: t("giteeClientId"), value: giteeClientId, onChange: (event) => setGiteeClientId(event.currentTarget.value), style: { flex: 1, minWidth: 0 } }),
										el("input", { type: "password", placeholder: t("giteeClientSecret"), value: giteeClientSecret, onChange: (event) => setGiteeClientSecret(event.currentTarget.value), style: { flex: 2, minWidth: 0 } }),
										el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy || !giteeClientId.trim() || !giteeClientSecret.trim(), onClick: saveGiteeSetup }, t("giteeSave"))),
									el("div", { className: styles.rowTop },
										el("button", { type: "button", className: styles.toggle, disabled: giteeStatus !== null && !giteeStatus.clientConfigured, onClick: startGiteeOauth }, t("giteeLoginBtn")),
										giteeStatus !== null && giteeStatus.hasToken
											? el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: () => sourcesAction({ action: "gitee-clear" }) }, t("giteeClear"))
											: null),
									]),
								),
							el("div", { className: styles.rowTop },
								el("button", { type: "button", className: styles.toggle, disabled: sourcesBusy, onClick: () => sourcesAction({ action: "reset" }) }, t("resetSources")),
								el("button", { type: "button", className: styles.toggle, onClick: () => setSourcesOpen(false) }, t("closeModal")))))
					: null,
			);
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-console: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "console",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({}),
			}, PluginConsoleTab));
		}
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
