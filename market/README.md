# 插件市场索引

给 DSH「发现」页用的索引文件（format 1）。

## 怎么用

1. 插件 → 实验性插件 → 打开「自定义插件市场」
2. 切到「发现」→ 添加索引源 → 粘贴：

```
https://TASHKENT-SN.github.io/dsh-memory-retrieval/market/index.json
```

## 里面是什么

- `index.json`：本插件的版本、来源（git commit 锁定）、兼容的 DSH 版本
- `icons/icon.png`：卡片图标

新增版本时，改 `index.json` 里的 `versions`（版本号、`publishTimestamp`、`source.commit`），
`source.commit` 必须是包含该版本代码的完整 40 位 SHA。
