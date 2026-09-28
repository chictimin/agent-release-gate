// 승인함 UI 실행 점검. 서버 기동 상태에서 `node scripts/ui-smoke.mjs [baseUrl]`.
// 설치 없는 최소 DOM 스텁 + 실제 서버로 인라인 스크립트를 실행한다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = process.argv[2] || "http://127.0.0.1:7788";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "src", "ui.html"), "utf8");
const code = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));

function assert(cond, msg) {
  if (!cond) throw new Error("smoke FAIL: " + msg);
  console.log("ok: " + msg);
}

class Elem {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.className = "";
    this.id = "";
    this.type = "";
    this.value = "";
    this.disabled = false;
    this.placeholder = "";
    this.open = false;
    this.style = {};
    this.attrs = {};
    this._text = "";
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  click() {
    (this.listeners.click || []).forEach((fn) => fn());
  }
}

const registry = {};
for (const id of ["list", "detail", "stats", "runAll", "tabPending", "tabHistory"]) {
  registry[id] = new Elem("div");
  registry[id].id = id;
}
function findById(root, id) {
  if (!root || typeof root !== "object") return null;
  if (root.id === id) return root;
  for (const c of root.children || []) {
    if (c && typeof c === "object" && "children" in c) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
  }
  return null;
}
function findAll(root, pred, out) {
  out = out || [];
  if (!root || typeof root !== "object") return out;
  if (pred(root)) out.push(root);
  for (const c of root.children || []) findAll(c, pred, out);
  return out;
}
function collectLines(root, out) {
  out = out || [];
  if (!root || typeof root !== "object") return out;
  if (typeof root._text === "string" && root._text !== "") {
    for (const l of root._text.split("\n")) out.push(l);
  }
  if (typeof root.text === "string") {
    for (const l of root.text.split("\n")) out.push(l);
  }
  for (const c of root.children || []) collectLines(c, out);
  return out;
}

const docListeners = {};
globalThis.document = {
  createElement: (tag) => new Elem(tag),
  createTextNode: (text) => ({ text: String(text) }),
  addEventListener: (t, fn) => {
    (docListeners[t] = docListeners[t] || []).push(fn);
  },
  getElementById: (id) =>
    registry[id] ||
    findById(registry.detail, id) ||
    findById(registry.list, id) ||
    null,
};
const realFetch = globalThis.fetch;
globalThis.fetch = (p, o) => realFetch(baseUrl + p, o);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  new Function(code);
  console.log("ok: script parses");

  let asyncError = null;
  process.on("unhandledRejection", (e) => {
    asyncError = e;
  });
  (0, eval)(code);
  await sleep(1500);
  if (asyncError) throw asyncError;
  console.log("ok: script loads without exception");

  const stats = await (await realFetch(baseUrl + "/api/stats")).json();
  const pendingBtns = (registry.list.children || []).filter(
    (c) => c.listeners && c.listeners.click && c.listeners.click.length > 0,
  );
  assert(
    pendingBtns.length === stats.pending,
    `pending buttons ${pendingBtns.length} == stats.pending ${stats.pending}`,
  );

  // 대기 건 전수: 결정 바(승인·반려·사유 입력), diff 블록 수, 헤더 숨김
  const cases = await (await realFetch(baseUrl + "/api/cases")).json();
  const pendings = cases.filter((c) => c.status === "pending");
  for (const c of pendings) {
    const btn = pendingBtns.find(
      (b) => (b.attrs["data-case"] || "") === c.case_id,
    );
    assert(!!btn, `${c.case_id} button exists`);
    btn.click();
    await sleep(800);
    if (asyncError) throw asyncError;
    assert(!!findById(registry.detail, "approveBtn"), `${c.case_id} approve button`);
    assert(!!findById(registry.detail, "rejectBtn"), `${c.case_id} reject button`);
    assert(!!findById(registry.detail, "note"), `${c.case_id} reason input`);
    const blocks = findAll(
      registry.detail,
      (n) => n.tag === "details" && (n.className || "").split(" ").includes("filediff"),
    );
    const detail = await (await realFetch(`${baseUrl}/api/cases/${c.case_id}`)).json();
    assert(
      blocks.length === (detail.files || []).length,
      `${c.case_id} diff blocks ${blocks.length} == files ${(detail.files || []).length}`,
    );
    const bad = collectLines(registry.detail).filter(
      (l) => l.startsWith("diff --git ") || l.startsWith("+++ ") || l.startsWith("--- "),
    );
    assert(bad.length === 0, `${c.case_id} no git meta header lines`);
  }

  // 펼치기/접기 버튼
  const lastPending = pendings[pendings.length - 1];
  if (lastPending) {
    const blocks = () =>
      findAll(
        registry.detail,
        (n) => n.tag === "details" && (n.className || "").split(" ").includes("filediff"),
      );
    const collapse = findById(registry.detail, "collapseAll");
    const expand = findById(registry.detail, "expandAll");
    assert(!!collapse && !!expand, "expand/collapse buttons exist");
    collapse.click();
    assert(blocks().every((b) => b.open === false), "collapse all closes blocks");
    expand.click();
    assert(blocks().every((b) => b.open === true), "expand all opens blocks");
  }

  // 키보드 j: 다음 건으로 이동
  if (pendings.length >= 2) {
    const first = pendingBtns.find(
      (b) => (b.attrs["data-case"] || "") === pendings[0].case_id,
    );
    first.click();
    await sleep(800);
    (docListeners.keydown || []).forEach((fn) => fn({ key: "j", target: null }));
    await sleep(800);
    const h2 = findAll(registry.detail, (n) => n.tag === "h2")[0];
    assert(
      !!h2 && h2.textContent === pendings[1].case_id,
      `j moves to next case (${pendings[1].case_id})`,
    );
  }

  // 이력: 버튼 클릭 → 읽기 전용 결정 바 (버튼 없음, 커밋/결정 표시)
  const histories = cases.filter((c) => c.status !== "pending");
  const tabHistory = registry.tabHistory;
  tabHistory.click();
  await sleep(300);
  const histBtns = (registry.list.children || []).filter(
    (c) => c.listeners && c.listeners.click && c.listeners.click.length > 0,
  );
  assert(histBtns.length === histories.length, `history buttons ${histBtns.length}`);
  for (const c of histories) {
    const btn = histBtns.find((b) => (b.attrs["data-case"] || "") === c.case_id);
    assert(!!btn, `${c.case_id} history button exists`);
    btn.click();
    await sleep(800);
    if (asyncError) throw asyncError;
    assert(!findById(registry.detail, "approveBtn"), `${c.case_id} no approve button`);
    assert(!findById(registry.detail, "rejectBtn"), `${c.case_id} no reject button`);
    const text = collectLines(registry.detail).join("\n");
    assert(
      text.includes("결정") || text.includes("커밋"),
      `${c.case_id} shows decision or commit`,
    );
  }
  console.log("SMOKE PASS");
}

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
