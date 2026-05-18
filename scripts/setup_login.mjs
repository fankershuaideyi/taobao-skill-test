import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import os from "node:os";
import path from "node:path";

const userDataDir = path.join(
  os.homedir(),
  ".openclaw/browser-profiles/taobao-playwright"
);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: "chrome",
  viewport: {
    width: 1400,
    height: 900
  },
  args: [
    "--no-first-run",
    "--no-default-browser-check"
  ]
});

const page = context.pages()[0] || await context.newPage();

await page.goto("https://www.taobao.com", {
  waitUntil: "domcontentloaded",
  timeout: 60000
});

console.log("\n请在打开的浏览器窗口中手动登录淘宝。");
console.log("登录成功后，回到当前终端按 Enter 保存登录态。\n");

const rl = readline.createInterface({ input, output });
await rl.question("登录完成后按 Enter：");
rl.close();

await page.waitForTimeout(2000);

console.log("正在关闭浏览器并保存登录态...");
await context.close();

console.log("淘宝登录态已保存到：");
console.log(userDataDir);
