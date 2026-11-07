window.__ModuleLoader__.load({
  id: "dsh-memory-retrieval",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const inject = ["slots"];

    const BASE = "/api/dsh-memory-retrieval";

    const CARD = {
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-3)",
      borderRadius: 10,
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    };
    const H2 = { fontSize: 14, fontWeight: 600, margin: 0, color: "var(--dsw-alias-label-primary)" };
    const NOTE = { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0, lineHeight: 1.6 };
    const FIELD = {
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: 8,
      padding: "7px 9px",
      fontSize: 13,
      width: "100%",
      boxSizing: "border-box",
      fontFamily: "inherit",
    };
    const BTN = {
      background: "rgba(77, 166, 255, 0.16)",
      color: "#4da6ff",
      border: "1px solid rgba(77, 166, 255, 0.35)",
      borderRadius: 8,
      padding: "6px 12px",
      fontSize: 12,
      cursor: "pointer",
    };
    const GHOST = {
      background: "transparent",
      color: "var(--dsw-alias-label-secondary)",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: 8,
      padding: "6px 12px",
      fontSize: 12,
      cursor: "pointer",
    };
    const LABEL = { fontSize: 12, color: "var(--dsw-alias-label-secondary)", display: "flex", flexDirection: "column", gap: 5 };
    const ROW = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 };

    const api = {
      get: () => fetch(`${BASE}/config`).then((r) => r.json()),
      sessions: () => fetch(`${BASE}/sessions`).then((r) => r.json()),
      collections: () => fetch(`${BASE}/collections`).then((r) => r.json()),
      mutate: (payload) =>
        fetch(`${BASE}/collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then((r) => r.json()),
      preview: (collectionId, query) =>
        fetch(`${BASE}/collections/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collectionId, query }),
        }).then((r) => r.json()),
      save: (config) =>
        fetch(`${BASE}/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        }).then((r) => r.json()),
      toggleSession: (sessionId, enabled) =>
        fetch(`${BASE}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, enabled }),
        }).then((r) => r.json()),
      toggleWorkspace: (workspace, globalRetrieval) =>
        fetch(`${BASE}/workspace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace, globalRetrieval }),
        }).then((r) => r.json()),
    };

    const bytesText = (bytes) => {
      if (!bytes) return "0 KB";
      if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    function SessionChip({ session, collections, onDragStart, onDragEnd, onAdd, dragging }) {
      const title = session.title || session.id;
      return h(
        "div",
        {
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.setData("text/plain", session.id);
            event.dataTransfer.effectAllowed = "copy";
            onDragStart(session.id);
          },
          onDragEnd,
          title: `${title}\n${session.workspace || session.cwd || ""}\n拖动到右侧集合，或用右侧下拉加入`,
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 7px",
            borderRadius: 7,
            cursor: "grab",
            background: dragging ? "rgba(77,166,255,0.22)" : "var(--dsw-alias-bg-layer-1)",
            border: "1px solid var(--dsw-alias-border-l1)",
            fontSize: 12,
            color: "var(--dsw-alias-label-primary)",
          },
        },
        session.running ? h("span", { style: { width: 6, height: 6, borderRadius: 3, background: "#58b368", flex: "0 0 auto" } }) : null,
        h(
          "span",
          { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          title,
        ),
        collections.length
          ? h(
              "select",
              {
                value: "",
                onMouseDown: (event) => event.stopPropagation(),
                onChange: (event) => {
                  if (event.target.value) onAdd(event.target.value, session.id);
                  event.target.value = "";
                },
                title: "加入集合",
                style: {
                  background: "transparent",
                  color: "var(--dsw-alias-label-secondary)",
                  border: "1px solid var(--dsw-alias-border-l1)",
                  borderRadius: 6,
                  fontSize: 11,
                  maxWidth: 62,
                },
              },
              h("option", { value: "" }, "加入…"),
              collections.map((collection) =>
                h("option", { key: collection.id, value: collection.id }, collection.name),
              ),
            )
          : null,
      );
    }

    function CollectionCard({ collection, hovered, handlers, test }) {
      const total = collection.sessions.reduce((sum, session) => sum + (session.bytes || 0), 0);
      return h(
        "div",
        {
          onDragOver: (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            handlers.hover(collection.id);
          },
          onDragLeave: () => handlers.hover(null),
          onDrop: (event) => {
            event.preventDefault();
            const sessionId = event.dataTransfer.getData("text/plain") || handlers.draggingId();
            if (sessionId) handlers.add(collection.id, sessionId);
            handlers.hover(null);
          },
          style: {
            border: hovered ? "1px dashed #4da6ff" : "1px solid var(--dsw-alias-border-l1)",
            background: hovered ? "rgba(77,166,255,0.08)" : "var(--dsw-alias-bg-layer-2)",
            borderRadius: 10,
            padding: "9px 11px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8 } },
          h("input", {
            type: "checkbox",
            checked: collection.enabled !== false,
            title: "关掉后这个集合不参与检索",
            onChange: (event) => handlers.toggle(collection.id, event.target.checked),
          }),
          h("input", {
            defaultValue: collection.name,
            key: `${collection.id}-${collection.name}`,
            onBlur: (event) => {
              const name = event.target.value.trim();
              if (name && name !== collection.name) handlers.rename(collection.id, name);
            },
            style: {
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 6,
              color: "var(--dsw-alias-label-primary)",
              fontSize: 13,
              fontWeight: 600,
              padding: "3px 5px",
            },
          }),
          h("span", { style: { ...NOTE, flex: "0 0 auto" } }, `${collection.sessions.length} 会话 · ${bytesText(total)}`),
          h("button", { style: { ...GHOST, padding: "3px 8px" }, onClick: () => handlers.removeCollection(collection.id) }, "删除"),
        ),
        collection.sessions.length === 0
          ? h("div", { style: { ...NOTE, padding: "10px 8px", border: "1px dashed var(--dsw-alias-border-l1)", borderRadius: 8, textAlign: "center" } }, "把左侧会话拖进来")
          : h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              collection.sessions.map((session) =>
                h(
                  "span",
                  {
                    key: session.id,
                    title: session.exists === false ? "本地找不到这个会话的日志" : session.workspace || session.id,
                    style: {
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      maxWidth: 260,
                      padding: "4px 7px",
                      borderRadius: 999,
                      fontSize: 12,
                      background: "var(--dsw-alias-bg-layer-1)",
                      border: session.exists === false ? "1px solid #e05a5a" : "1px solid var(--dsw-alias-border-l1)",
                      color: "var(--dsw-alias-label-primary)",
                    },
                  },
                  session.running
                    ? h("span", { style: { width: 6, height: 6, borderRadius: 3, background: "#58b368" } })
                    : null,
                  h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, session.title || session.id),
                  h(
                    "button",
                    {
                      onClick: () => handlers.remove(collection.id, session.id),
                      title: "移出集合",
                      style: { background: "transparent", border: "none", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 },
                    },
                    "×",
                  ),
                ),
              ),
            ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8 } },
          h("button", { style: { ...GHOST, padding: "3px 9px" }, onClick: () => test.open(collection.id) }, "试检索"),
          test.activeId === collection.id ? h("span", { style: NOTE }, "↓ 在下面输入问题") : null,
        ),
      );
    }

    function MemorySettings() {
      const [state, setState] = React.useState({
        loading: true,
        busy: false,
        config: null,
        memoryPath: "",
        memoryCount: 0,
        sessions: [],
        collections: [],
        capabilities: null,
        synonyms: null,
        message: "",
        draggingId: "",
        hover: null,
        testCollection: "",
        testQuery: "",
        testResult: null,
        testBusy: false,
        advanced: false,
      });

      const load = React.useCallback(() => {
        Promise.all([
          api.get(),
          api.sessions().catch(() => ({ ok: false, sessions: [] })),
          api.collections().catch(() => ({ ok: false, collections: [] })),
        ])
          .then(([data, sessionData, collectionData]) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "读取失败");
            setState((s) => ({
              ...s,
              loading: false,
              config: data.config,
              memoryPath: data.memoryPath,
              memoryCount: data.memoryCount,
              sessions: sessionData && sessionData.ok ? sessionData.sessions || [] : [],
              collections: collectionData && collectionData.ok ? collectionData.collections || [] : [],
              capabilities: (collectionData && collectionData.capabilities) || null,
              synonyms: data.synonyms || null,
              message: "",
            }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, loading: false, message: "读取失败：" + String((error && error.message) || error) }));
          });
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const mutate = (payload) => {
        setState((s) => ({ ...s, busy: true, message: "" }));
        api.mutate(payload)
          .then((data) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "操作失败");
            setState((s) => ({ ...s, busy: false, collections: data.collections || [] }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, busy: false, message: "操作失败：" + String((error && error.message) || error) }));
          });
      };

      const handlers = {
        add: (collectionId, sessionId) => mutate({ action: "add", collectionId, sessionId }),
        remove: (collectionId, sessionId) => mutate({ action: "remove", collectionId, sessionId }),
        rename: (collectionId, name) => mutate({ action: "rename", collectionId, name }),
        toggle: (collectionId, enabled) => mutate({ action: "toggle", collectionId, enabled }),
        removeCollection: (collectionId) => mutate({ action: "delete", collectionId }),
        create: (sessionId) => mutate({ action: "create", name: "新集合", sessionIds: sessionId ? [sessionId] : [] }),
        hover: (id) => setState((s) => ({ ...s, hover: id })),
        draggingId: () => state.draggingId,
      };

      const test = {
        open: (id) => setState((s) => ({ ...s, testCollection: id, testResult: null })),
        activeId: state.testCollection,
      };

      // 会话开关 / 工作区「全局检索」开关：走原来的 /session、/workspace 接口
      const toggleSession = (sessionId, enabled) => {
        api.toggleSession(sessionId, enabled)
          .then((data) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "切换失败");
            setState((s) => ({ ...s, sessions: data.sessions || [], message: "" }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, message: "切换失败：" + String((error && error.message) || error) }));
          });
      };

      const toggleWorkspace = (workspace, globalRetrieval) => {
        api.toggleWorkspace(workspace, globalRetrieval)
          .then((data) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "切换失败");
            setState((s) => ({
              ...s,
              sessions: data.sessions || [],
              config: { ...s.config, workspaceGlobalRetrieval: { ...(s.config.workspaceGlobalRetrieval || {}), [workspace]: globalRetrieval } },
              message: "",
            }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, message: "切换失败：" + String((error && error.message) || error) }));
          });
      };

      const runPreview = () => {
        if (!state.testCollection || !state.testQuery.trim()) return;
        setState((s) => ({ ...s, testBusy: true, testResult: null }));
        api.preview(state.testCollection, state.testQuery)
          .then((data) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "检索失败");
            setState((s) => ({ ...s, testBusy: false, testResult: data }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, testBusy: false, message: "检索失败：" + String((error && error.message) || error) }));
          });
      };

      const patch = (key, value) => setState((s) => ({ ...s, config: { ...s.config, [key]: value }, message: "" }));

      const save = () => {
        if (!state.config || state.busy) return;
        setState((s) => ({ ...s, busy: true, message: "" }));
        api.save(state.config)
          .then((data) => {
            if (!data || !data.ok) throw new Error((data && data.error) || "保存失败");
            setState((s) => ({
              ...s,
              busy: false,
              config: data.config,
              memoryPath: data.memoryPath,
              memoryCount: data.memoryCount,
              message: "已保存，下一轮对话立即生效。",
            }));
          })
          .catch((error) => {
            setState((s) => ({ ...s, busy: false, message: "保存失败：" + String((error && error.message) || error) }));
          });
      };

      if (state.loading) return h("p", { style: NOTE }, "读取配置中…");
      if (!state.config) return h("p", { style: NOTE }, state.message || "配置不可用");

      const cfg = state.config;
      const groups = [];
      const groupIndex = new Map();
      for (const session of state.sessions) {
        const key = session.workspace || session.cwd || "未分组";
        let group = groupIndex.get(key);
        if (!group) {
          group = { key, sessions: [] };
          groupIndex.set(key, group);
          groups.push(group);
        }
        group.sessions.push(session);
      }

      const field = (key, label, type, extra = {}) =>
        h(
          "label",
          { style: LABEL },
          label,
          h("input", {
            style: FIELD,
            type: type || "text",
            value: cfg[key] ?? "",
            onChange: (event) => patch(key, type === "number" ? Number(event.target.value) : event.target.value),
            ...extra,
          }),
        );

      const check = (key, label, note) =>
        h(
          "label",
          { style: { ...LABEL, flexDirection: "row", alignItems: "center", gap: 8 } },
          h("input", { type: "checkbox", checked: cfg[key] !== false, onChange: (event) => patch(key, event.target.checked) }),
          h("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13 } }, label),
          note ? h("span", { style: NOTE }, note) : null,
        );

      return h(
        "div",
        { style: CARD },
        h("h2", { style: H2 }, "记忆检索"),
        h(
          "p",
          { style: NOTE },
          "把左侧会话拖到右侧集合里。集合内的会话会互相检索对方的历史对话：原文仍各存各的，只在需要时把最相关的片段带进 prompt。检索全在本地完成，不调用 API。",
        ),
        h(
          "div",
          { style: { display: "flex", gap: 18, flexWrap: "wrap" } },
          check("enabled", "开启记忆检索"),
          check("collectionRetrieval", "启用集合检索"),
          check("askWhenUnsure", "拿不准时先问用户"),
        ),
        state.capabilities && state.capabilities.zstd === false
          ? h(
              "p",
              { style: { ...NOTE, color: "#e05a5a" } },
              `当前宿主 Node ${state.capabilities.node || "?"} 没有 zstd 解压能力（需要 22.15+），集合检索读不了会话日志。请升级 DSH/Electron。`,
            )
          : null,

        h(
          "div",
          // nowrap：设置面板窄的时候也不能把右栏折到下一行，
          // 否则会变成「上会话、下集合」，而界面文案说的是左右。
          { style: { display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "nowrap" } },
          // 左：会话列表
          h(
            "div",
            {
              style: {
                flex: "0 1 34%",
                minWidth: 180,
                maxWidth: 340,
                maxHeight: 460,
                overflowY: "auto",
                border: "1px solid var(--dsw-alias-border-l1)",
                borderRadius: 10,
                padding: "9px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--dsw-alias-bg-layer-2)",
              },
            },
            h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, `会话（${state.sessions.length}）· 拖动或下拉加入`),
            groups.map((group) =>
              h(
                "div",
                { key: group.key, style: { display: "flex", flexDirection: "column", gap: 5 } },
                h("div", { style: { ...NOTE, fontSize: 11, wordBreak: "break-all", opacity: 0.85 } }, `${group.key} · ${group.sessions.length}`),
                group.sessions.map((session) =>
                  h(SessionChip, {
                    key: session.id,
                    session,
                    collections: state.collections,
                    dragging: state.draggingId === session.id,
                    onDragStart: (id) => setState((s) => ({ ...s, draggingId: id })),
                    onDragEnd: () => setState((s) => ({ ...s, draggingId: "", hover: null })),
                    onAdd: (collectionId, sessionId) => handlers.add(collectionId, sessionId),
                  }),
                ),
              ),
            ),
          ),
          // 右：集合
          h(
            "div",
            { style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 } },
            state.collections.length === 0
              ? h("p", { style: NOTE }, "还没有集合。把左侧任意会话拖进下面的虚线框即可创建第一个。")
              : null,
            state.collections.map((collection) =>
              h(CollectionCard, {
                key: collection.id,
                collection,
                hovered: state.hover === collection.id,
                handlers,
                test,
              }),
            ),
            h(
              "div",
              {
                onDragOver: (event) => {
                  event.preventDefault();
                  handlers.hover("__new__");
                },
                onDragLeave: () => handlers.hover(null),
                onDrop: (event) => {
                  event.preventDefault();
                  const sessionId = event.dataTransfer.getData("text/plain") || state.draggingId;
                  handlers.create(sessionId);
                  handlers.hover(null);
                },
                onClick: () => handlers.create(""),
                style: {
                  border: state.hover === "__new__" ? "1px dashed #4da6ff" : "1px dashed var(--dsw-alias-border-l1)",
                  background: state.hover === "__new__" ? "rgba(77,166,255,0.08)" : "transparent",
                  borderRadius: 10,
                  padding: "14px 12px",
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--dsw-alias-label-secondary)",
                  cursor: "pointer",
                },
              },
              "＋ 拖到这里新建集合（或点一下创建空集合）",
            ),
          ),
        ),

        // 试检索
        state.testCollection
          ? h(
              "div",
              { style: { ...CARD, padding: "10px 12px", background: "var(--dsw-alias-bg-layer-2)", gap: 8 } },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "试检索"),
                h("span", { style: NOTE }, (state.collections.find((c) => c.id === state.testCollection) || {}).name || ""),
                h("button", { style: { ...GHOST, marginLeft: "auto", padding: "3px 9px" }, onClick: () => setState((s) => ({ ...s, testCollection: "", testResult: null })) }, "关闭"),
              ),
              h(
                "div",
                { style: { display: "flex", gap: 8 } },
                h("input", {
                  style: FIELD,
                  placeholder: "输入一句话，看这个集合会捞出哪些片段（和真实注入用的是同一套逻辑）",
                  value: state.testQuery,
                  onChange: (event) => setState((s) => ({ ...s, testQuery: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") runPreview();
                  },
                }),
                h("button", { style: BTN, disabled: state.testBusy, onClick: runPreview }, state.testBusy ? "检索中…" : "检索"),
              ),
              state.testResult
                ? h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    h(
                      "p",
                      { style: NOTE },
                      `${state.testResult.hits.length} 条命中 · 索引 ${state.testResult.stats.chunks} 段 / ${state.testResult.stats.chars} 字 · 耗时 ${state.testResult.elapsedMs}ms`,
                    ),
                    state.testResult.hits.map((hit, index) =>
                      h(
                        "div",
                        { key: index, style: { ...CARD, padding: "8px 10px", gap: 4, background: "var(--dsw-alias-bg-layer-1)" } },
                        h("div", { style: { ...NOTE, fontSize: 11 } }, `《${hit.title}》 · 相关度 ${hit.score}`),
                        h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary)", lineHeight: 1.6 } }, hit.text),
                      ),
                    ),
                    state.testResult.hits.length === 0 ? h("p", { style: NOTE }, "没命中：换个更具体的词（专有名词、编号、项目名效果最好）。") : null,
                  )
                : null,
            )
          : null,

        // 高级
        h(
          "button",
          { style: { ...GHOST, alignSelf: "flex-start" }, onClick: () => setState((s) => ({ ...s, advanced: !s.advanced })) },
          state.advanced ? "收起高级设置" : "高级设置（记忆文件、条数、字数上限）",
        ),
        state.advanced
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 10 } },
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "集合检索"),
              h(
                "div",
                { style: ROW },
                field("collectionTopK", "最多注入几段", "number", { min: 1, max: 20 }),
                field("collectionMaxChars", "注入总字数上限", "number", { min: 200, max: 8000 }),
              ),
              h(
                "div",
                { style: ROW },
                field("collectionPerSnippetChars", "单段截断字数", "number", { min: 80, max: 2000 }),
                field("collectionSessionCapChars", "每会话最多索引字数（0 = 全量）", "number", { min: 0 }),
              ),
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "匹配严格度与近义词"),
              h(
                "p",
                { style: NOTE },
                "严格度 = 一条查询里至少要命中几个词才算相关。设 1 时「原因」这类泛词也会命中，设 2（默认）能压掉大部分噪音；单字查询会自动放宽到 1。",
              ),
              h(
                "div",
                { style: ROW },
                field("minHits", "至少命中几个查询词", "number", { min: 1, max: 6 }),
                field("synonymWeight", "同义词权重（原词为 1）", "number", { min: 0.1, max: 1, step: 0.1 }),
              ),
              check(
                "synonymsEnabled",
                "启用近义词扩展",
                state.synonyms
                  ? `已加载 ${state.synonyms.groups} 组 / 文件：${state.synonyms.path}`
                  : "把「网速慢」扩成「卡顿、延迟」这类同组词再匹配",
              ),
              field("synonymPath", "同义词表路径", "text", { placeholder: "留空 = ~/.dsh/dsh-memory-retrieval/synonyms.json 或内置表" }),
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "联想节奏"),
              h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 4 } },
                h(
                  "label",
                  { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
                  h("input", {
                    type: "checkbox",
                    checked: cfg.recallMidTask === true,
                    onChange: (event) => patch("recallMidTask", event.target.checked),
                    style: { flex: "0 0 auto", margin: 0 },
                  }),
                  h(
                    "span",
                    { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" } },
                    "任务中途也继续联想",
                  ),
                ),
                h(
                  "p",
                  { style: { ...NOTE, margin: 0, paddingLeft: 22 } },
                  "关（默认）：一个任务只在你开口时联想一次，之后 3 轮内不重复。开：每一步都可能想起新片段——更像人边干活边想起来，但也更容易跑题（ADHD 感）。",
                ),
              ),
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "自己的历史（被动）"),
              h(
                "p",
                { style: NOTE },
                "从当前会话自己的完整日志里捞较早的片段。本地建索引、本地去重；只有当前上下文里没有的旧片段才会注入，不额外调 API。",
              ),
              check(
                "selfRetrieval",
                "开启被动自检索",
                "默认开；关掉后只查 memory.jsonl 和集合里的其它会话。",
              ),
              h(
                "div",
                { style: ROW },
                field("selfTopK", "最多注入几段", "number", { min: 1, max: 5 }),
                field("selfMaxChars", "注入总字数上限", "number", { min: 200, max: 2000 }),
                field("selfMinAgeMinutes", "只取多少分钟以前的消息", "number", { min: 0, max: 1440 }),
              ),
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "全量记忆卡"),
              h(
                "p",
                { style: NOTE },
                "单独读一份角色记忆卡（JSON），不依赖会话日志，因此不会被唤醒模板污染。可以让 DeepSeek 找到角色的 memory-card.json，把路径填在这里。",
              ),
              check("memoryCardRetrieval", "启用全量记忆卡检索", "关掉后只查 memory.jsonl、集合和自检索。"),
              field("memoryCardPath", "记忆卡 JSON 路径", "text", { placeholder: "例如 C:\\Users\\you\\.dsh\\surfcore\\characters\\<角色>\\memory\\memory-card.json" }),
              h(
                "label",
                { style: LABEL },
                "关联会话 ID（逗号分隔）",
                h("input", {
                  type: "text",
                  style: FIELD,
                  value: (cfg.memoryCardSessionIds || []).join(", "),
                  onChange: (event) => patch(
                    "memoryCardSessionIds",
                    event.target.value.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean),
                  ),
                }),
              ),
              check(
                "memoryCardAutoDisableSelf",
                "注入记忆卡时暂停关联会话的自检索",
                "本轮记忆卡命中后，关联会话不再跑被动自检索；取消勾选即可恢复。",
              ),
              h(
                "div",
                { style: ROW },
                field("memoryCardTopK", "最多注入几段", "number", { min: 1, max: 10 }),
                field("memoryCardMaxChars", "注入总字数上限", "number", { min: 200, max: 4000 }),
              ),
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "记忆文件（memory.jsonl）"),
              field("label", "记忆标签", "text", { placeholder: "Memory" }),
              field("memoryPath", "记忆文件路径", "text", { placeholder: "留空 = ~/.dsh/dsh-memory-retrieval/memory.jsonl" }),
              h("p", { style: NOTE }, "当前文件：" + state.memoryPath + " · " + state.memoryCount + " 条"),
              h(
                "div",
                { style: ROW },
                field("topK", "最多注入几条", "number", { min: 1, max: 20 }),
                field("maxChars", "注入总字数上限", "number", { min: 200, max: 4000 }),
              ),
              h(
                "div",
                { style: ROW },
                field("perRecordChars", "单条截断字数", "number", { min: 60, max: 1000 }),
                field("minScore", "最低相关分", "number", { min: 0, max: 100 }),
              ),
              // 逐工作区「全局检索」+ 逐会话开关（原设置页功能，收进高级里）
              h("p", { style: { ...NOTE, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "会话开关（按工作区分组）"),
              h(
                "p",
                { style: NOTE },
                "工作区旁的勾是「全局检索」：勾上后该工作区的会话可以跨工作区检索 memory.jsonl；不勾只查本工作区。单个会话的勾决定它自己是否参与检索。",
              ),
              h(
                "div",
                {
                  style: {
                    ...CARD,
                    padding: "9px 11px",
                    gap: 8,
                    background: "var(--dsw-alias-bg-layer-2)",
                    maxHeight: 300,
                    overflowY: "auto",
                  },
                },
                state.sessions.length === 0
                  ? h("p", { style: NOTE }, "还没有会话；打开一个会话后点「重新读取」。")
                  : groups.map((group) =>
                      h(
                        "div",
                        { key: group.key, style: { display: "flex", flexDirection: "column", gap: 5 } },
                        h(
                          "label",
                          {
                            style: {
                              ...NOTE,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              fontWeight: 600,
                              color: "var(--dsw-alias-label-secondary)",
                              wordBreak: "break-all",
                            },
                          },
                          h("input", {
                            type: "checkbox",
                            checked: group.sessions[0]?.globalRetrieval === true,
                            onChange: (event) => toggleWorkspace(group.key, event.target.checked),
                            title: "开启后跨工作区检索 memory.jsonl；关闭时只检索本工作区",
                          }),
                          h("span", null, "全局检索"),
                          h("span", { style: { fontWeight: 400 } }, group.key + " · " + group.sessions.length + " 个会话"),
                        ),
                        group.sessions.map((session) =>
                          h(
                            "label",
                            {
                              key: session.id,
                              style: {
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 12,
                                color: "var(--dsw-alias-label-primary)",
                                paddingLeft: 8,
                              },
                            },
                            h("input", {
                              type: "checkbox",
                              checked: session.enabled !== false,
                              onChange: (event) => toggleSession(session.id, event.target.checked),
                            }),
                            h(
                              "span",
                              {
                                style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                                title: session.title || session.id,
                              },
                              session.title || session.id.slice(0, 18),
                            ),
                            session.running ? h("span", { style: { ...NOTE, color: "#58b368" } }, "运行中") : null,
                            session.available === false ? h("span", { style: NOTE }, "未加载") : null,
                          ),
                        ),
                      ),
                    ),
              ),
            )
          : null,

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12 } },
          h("button", { style: BTN, disabled: state.busy, onClick: save }, state.busy ? "保存中…" : "保存"),
          h("button", { style: GHOST, onClick: load }, "重新读取"),
        ),
        state.message
          ? h("p", { style: { ...NOTE, color: state.message.includes("失败") ? "#e05a5a" : "#58b368" } }, state.message)
          : null,
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;
      slots.inject("settings.section", () =>
        slots.register(
          { name: "settings.section", id: "dsh-memory-retrieval", order: 45, label: "记忆检索" },
          () => React.createElement(MemorySettings),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
