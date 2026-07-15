# AI 价格比对

线上地址：

- Surge：https://ai-price-compare.surge.sh
- GitHub Pages：https://zhuxi99.github.io/ai-price-compare.github.io/

## 更新并发布数据

1. 在网页中完成价格修改。
2. 点击“导出 JSON”，将备份保存到下载目录。
3. 双击桌面上的“AI价格比对－一键发布”，等待终端显示 Surge 和 GitHub Pages 均发布成功。

也可以在本项目目录运行：

   ```bash
   npm run deploy:data
   ```

脚本会从 `~/下载`（或 `~/Downloads`）自动选择最新的有效非空备份，将数据写入 `.surge/index.html` 和 GitHub Pages 使用的根目录 `index.html`，部署到固定 Surge 域名，然后自动提交并推送 `index.html` 到 GitHub `main` 分支。空备份和格式错误的文件会被跳过。

也可以明确指定备份文件：

```bash
npm run deploy:data -- "/完整路径/ai-price-data-日期.json"
```

只生成 `.surge/index.html` 而不发布：

```bash
npm run deploy:prepare
```

如果 Surge 不在当前 PATH 中，可以指定可执行文件路径：

```bash
SURGE_BIN="/完整路径/surge" npm run deploy:data
```

每次部署新的导出文件后，访客刷新页面会自动切换到最新发布的数据。访客在自己浏览器中的临时修改不会上传到网站。
