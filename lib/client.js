window.__ModuleLoader__.load({
  id: "dsh-archived-conversation",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const createElement = react.createElement;

    const inject = ["slots"];

    const css = ".ac_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}.ac_heading{display:flex;align-items:baseline;gap:8px;padding:0 2px}.ac_heading h3{font-size:18px;font-weight:600;line-height:26px;margin:0}.ac_heading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}.ac_search{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d5dd);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1d2939);font:inherit;font-size:13px;line-height:20px;padding:7px 11px;outline:none}.ac_search::placeholder{color:var(--dsw-alias-label-tertiary,#98a2b3)}.ac_search:focus{border-color:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 15%,transparent)}.ac_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.ac_notice{color:var(--dsw-alias-state-business-primary,#4c8dff);font-size:12px;line-height:18px}.ac_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:8px 2px}.ac_group{display:flex;flex-direction:column;gap:8px}.ac_groupTitle{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);padding:0 2px}.ac_count{color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}.ac_family{display:flex;flex-direction:column}.ac_row{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 14px}.ac_row[role=button]{cursor:pointer}.ac_row[role=button]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}.ac_rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.ac_titleLine{display:flex;align-items:center;gap:7px;min-width:0}.ac_chevron{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}.ac_chevron[data-open=true]{transform:rotate(180deg)}.ac_title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ac_badge{display:inline-flex;align-items:center;margin-left:8px;padding:0 8px;min-height:18px;border-radius:5px;font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}.ac_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.ac_children{border:1px solid var(--dsw-alias-border-l2);border-top:0;border-radius:0 0 10px 10px;margin:-1px 8px 0;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#fff)}.ac_child{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.ac_child:last-child{border-bottom:0}.ac_childMeta{color:var(--dsw-alias-label-tertiary);font-size:11px}.ac_actions{margin-left:auto;display:flex;gap:6px;flex:none}.ac_btn{cursor:pointer;font-size:12px;line-height:18px;padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.ac_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.ac_btn:disabled{opacity:.5;cursor:default}.ac_btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.ac_btn.danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}.ac_overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000}.ac_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv1);padding:20px;max-width:360px;width:100%;display:flex;flex-direction:column;gap:12px}.ac_dialogTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}.ac_dialogBody{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-line}.ac_dialogActions{display:flex;justify-content:flex-end;gap:8px}";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-archived-conversation"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-archived-conversation";
      tag.dataset.pluginCss = "dsh-archived-conversation";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function api(path, options) {
      return fetch("/archived-conversation/api" + path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));
    }

    function applyMutationResult(r, failLabel, setError, refresh) {
      if (!r.ok) {
        setError(r.body.error || `${failLabel} (HTTP ${r.status})`);
        return;
      }
      if (r.body.ok === false) {
        setError(r.body.error || failLabel);
        if (r.body.queued) refresh();
        return;
      }
      refresh();
    }

    function ovText(status) {
      return (
        {
          deleted: "已同步删除 OpenViking 会话记录",
          queued: "OpenViking 清理暂时失败，已排队，将在下次启动时自动重试",
          skipped: "未配置 OpenViking，仅删除本地会话",
        }[status] || ""
      );
    }

    function fmtTime(ms) {
      if (!ms) return "";
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return "";
      }
    }

    function filterArchivedGroups(groups, query) {
      const needle = String(query ?? "").trim().toLowerCase();
      if (needle === "") return groups;
      const filtered = [];
      for (const group of groups) {
        if (String(group.project ?? "").toLowerCase().includes(needle)) {
          filtered.push(group);
          continue;
        }
        const sessions = group.sessions.filter((session) =>
          String(session.title ?? "").toLowerCase().includes(needle)
          || String(session.id ?? "").toLowerCase().includes(needle)
          || (session.children ?? []).some((child) =>
            String(child.title ?? "").toLowerCase().includes(needle)
            || String(child.id ?? "").toLowerCase().includes(needle)),
        );
        if (sessions.length > 0) filtered.push({ ...group, sessions });
      }
      return filtered;
    }

    function SessionRow({ session, pending, busy, expanded, onToggle, onUnarchive, onDelete, confirming, setConfirming }) {
      const children = session.children ?? [];
      const expandable = children.length > 0;
      const activate = () => { if (expandable) onToggle(); };
      return createElement(
        "div",
        { className: "ac_family", key: session.id },
        createElement("div", {
          className: "ac_row",
          role: expandable ? "button" : undefined,
          tabIndex: expandable ? 0 : undefined,
          "aria-expanded": expandable ? expanded : undefined,
          onClick: activate,
          onKeyDown: (event) => {
            if (expandable && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onToggle();
            }
          },
        },
          createElement("div", { className: "ac_rowMain" },
            createElement("div", { className: "ac_titleLine" },
              expandable ? createElement("svg", { className: "ac_chevron", "data-open": expanded, viewBox: "0 0 20 20", "aria-hidden": "true" },
                createElement("path", { d: "M5 7.5 10 12.5 15 7.5", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" })) : null,
          createElement(
            "div",
            { className: "ac_title" },
            session.title || "未命名对话",
            pending
              ? createElement("span", { className: "ac_badge", title: "该对话仍被 DSH 使用,释放后(通常重启 DSH 后)将自动删除" }, "等待删除")
              : null,
              ),
            ),
          createElement("div", { className: "ac_meta" }, fmtTime(session.updatedAt)),
        ),
        createElement(
          "div",
          { className: "ac_actions" },
          createElement("button", { className: "ac_btn", onClick: (event) => { event.stopPropagation(); onUnarchive(); }, disabled: busy }, "取消归档"),
          createElement("button", { className: "ac_btn danger", onClick: (event) => { event.stopPropagation(); setConfirming(true); }, disabled: busy }, "删除"),
        ),
        confirming
          ? createElement(
              "div",
              { className: "ac_overlay", onClick: (event) => { event.stopPropagation(); setConfirming(false); } },
              createElement(
                "div",
                { className: "ac_dialog", onClick: (e) => e.stopPropagation() },
                createElement("div", { className: "ac_dialogTitle" }, "删除对话"),
                createElement("div", { className: "ac_dialogBody" }, `确定要删除「${session.title || "未命名对话"}」及其 ${children.length} 个子代理对话吗？此操作不可恢复。\n将同时删除 OpenViking 中这些会话的记录与未提炼内容（已提炼记忆保留）。`),
                createElement(
                  "div",
                  { className: "ac_dialogActions" },
                  createElement("button", { className: "ac_btn", onClick: () => setConfirming(false) }, "取消"),
                  createElement("button", { className: "ac_btn danger", onClick: onDelete, disabled: busy }, busy ? "…" : "删除"),
                ),
              ),
            )
          : null,
        ),
        expandable && expanded
          ? createElement("div", { className: "ac_children" }, children.map((child) =>
              createElement("div", { className: "ac_child", key: child.id, style: { paddingLeft: `${8 + Math.max(0, child.depth - 1) * 16}px` } },
                createElement("div", null, child.title || child.id),
                createElement("div", { className: "ac_childMeta" }, `子代理 · ${child.mode === "continuable" ? "可继续" : "单次"}`),
              )))
          : null,
      );
    }

    function ArchivedSection() {
      const [groups, setGroups] = react.useState([]);
      const [pending, setPending] = react.useState([]);
      const [busyId, setBusyId] = react.useState(null);
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [confirmId, setConfirmId] = react.useState(null);
      const [query, setQuery] = react.useState("");
      const [expandedIds, setExpandedIds] = react.useState(() => new Set());

      const refresh = react.useCallback(() => {
        api("/list")
          .then((r) => {
            if (!r.ok) return;
            const g = r.body.groups ?? [];
            const p = r.body.pending ?? [];
            setGroups((prev) => (JSON.stringify(prev) === JSON.stringify(g) ? prev : g));
            setPending((prev) => (JSON.stringify(prev) === JSON.stringify(p) ? prev : p));
          })
          .catch(() => {});
      }, []);
      react.useEffect(() => {
        refresh();
        const t = setInterval(refresh, 20000);
        const onFocus = () => refresh();
        window.addEventListener("focus", onFocus);
        return () => {
          clearInterval(t);
          window.removeEventListener("focus", onFocus);
        };
      }, [refresh]);

      const unarchive = async (id) => {
        setBusyId(id);
        setError("");
        try {
          const r = await api(`/${id}/unarchive`, { method: "POST" });
          applyMutationResult(r, "取消归档失败", setError, refresh);
        } catch (e) {
          setError(String(e));
        }
        setBusyId(null);
      };

      const del = async (id) => {
        setBusyId(id);
        setError("");
        setNotice("");
        setConfirmId(null);
        try {
          const r = await api(`/${id}`, { method: "DELETE" });
          applyMutationResult(r, "删除失败", setError, refresh);
          const ov = r.body?.ov;
          setNotice(ov ? ovText(ov) : "");
        } catch (e) {
          setError(String(e));
        }
        setBusyId(null);
      };

      const total = groups.reduce((n, g) => n + g.sessions.length, 0);
      const filteredGroups = react.useMemo(() => filterArchivedGroups(groups, query), [groups, query]);
      const pendingSet = react.useMemo(() => new Set(pending), [pending]);
      const visibleTotal = filteredGroups.reduce((n, g) => n + g.sessions.length, 0);
      const searching = query.trim() !== "";
      return createElement(
        "div",
        { className: "ac_section" },
        createElement(
          "div",
          { className: "ac_heading" },
          createElement("h3", null, "已归档对话"),
          createElement("span", null, searching ? `${visibleTotal} / ${total}` : String(total)),
        ),
        total > 0
          ? createElement("input", {
              className: "ac_search",
              type: "search",
              value: query,
              maxLength: 200,
              autoComplete: "off",
              spellCheck: false,
              "aria-label": "搜索已归档对话",
              placeholder: "搜索标题、项目或会话 ID",
              onChange: (event) => setQuery(event.target.value),
            })
          : null,
        error ? createElement("div", { className: "ac_err" }, error) : null,
        notice ? createElement("div", { className: "ac_notice" }, notice) : null,
        total === 0
          ? createElement("div", { className: "ac_empty" }, "没有已归档的对话。可在左侧会话树中右键会话选择「归档」。")
          : visibleTotal === 0
            ? createElement("div", { className: "ac_empty" }, "没有匹配的已归档对话。")
            : filteredGroups.map((g) =>
              createElement(
                "div",
                { className: "ac_group", key: g.project },
                createElement(
                  "div",
                  { className: "ac_groupTitle" },
                  g.project,
                  createElement("span", { className: "ac_count" }, String(g.sessions.length)),
                ),
                g.sessions.map((s) =>
                  createElement(SessionRow, {
                    session: s,
                    pending: pendingSet.has(s.id),
                    busy: busyId === s.id,
                    expanded: expandedIds.has(s.id),
                    onToggle: () => setExpandedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                      return next;
                    }),
                    onUnarchive: () => unarchive(s.id),
                    onDelete: () => del(s.id),
                    confirming: confirmId === s.id,
                    setConfirming: (v) => setConfirmId(v ? s.id : null),
                    key: s.id,
                  }),
                ),
              ),
            ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "archived-conversation",
            order: 60,
            label: "已归档",
          },
          ArchivedSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.filterArchivedGroups = filterArchivedGroups;
    exports.SessionRow = SessionRow;
    return module.exports;
  },
});
