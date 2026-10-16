import { describe, expect, it } from "vitest";
import { codeLang, highlight, type CodeLang, type Token, type TokenKind } from "./highlight";

const join = (t: Token[]) => t.map((x) => x.text).join("");
/** 그 글자를 담은 토큰의 종류. 같은 글자가 여럿이면 `nth` 번째. */
const kindOf = (t: Token[], text: string, nth = 0): TokenKind | undefined =>
  t.filter((x) => x.text === text)[nth]?.kind;
const kinds = (code: string, lang: CodeLang) => {
  const t = highlight(code, lang);
  return (text: string, nth = 0) => kindOf(t, text, nth);
};

describe("codeLang", () => {
  it("reads the fence word in any case and its common aliases", () => {
    expect(codeLang("java")?.lang).toBe("java");
    expect(codeLang("Python")?.lang).toBe("python");
    expect(codeLang("py")?.lang).toBe("python");
    expect(codeLang("PostgreSQL")?.lang).toBe("sql");
    expect(codeLang("tsx")?.lang).toBe("typescript");
    expect(codeLang("js")?.label).toBe("JavaScript");
    expect(codeLang("htm")?.lang).toBe("html");
    expect(codeLang("scss")?.lang).toBe("scss");
    expect(codeLang("jsonc")?.lang).toBe("json");
    expect(codeLang("{python}")?.lang).toBe("python");
  });

  it("is null without a language or for one it does not know", () => {
    expect(codeLang("")).toBeNull();
    expect(codeLang("bash")).toBeNull();
    expect(codeLang("rust")).toBeNull();
  });
});

describe("highlight — 글자를 잃지 않는다", () => {
  const LANGS: CodeLang[] = ["java", "python", "sql", "javascript", "typescript", "html", "xml", "css", "scss", "json"];
  const SOUP = ["\"", "'", "`", "/", "*", "<", ">", "{", "}", "$", "#", "@", "\\", "\n", " ", "-", "=", ":", ";", "a", "1", ".", "!", "[", "]", "(", ")", "가"];

  it("reproduces random input exactly in every language", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const lang of LANGS)
      for (let n = 0; n < 150; n++) {
        const len = Math.floor(rand() * 60);
        const code = Array.from({ length: len }, () => SOUP[Math.floor(rand() * SOUP.length)]).join("");
        expect(join(highlight(code, lang))).toBe(code);
      }
  });

  it("never emits empty tokens or two neighbours of the same kind", () => {
    const t = highlight('public class A { String s = "x"; }', "java");
    expect(t.every((x) => x.text.length > 0)).toBe(true);
    expect(t.every((x, i) => i === 0 || t[i - 1].kind !== x.kind)).toBe(true);
  });

  it("stays fast on a large block", () => {
    const code = "SELECT a, COUNT(*) FROM t WHERE b = 'x' -- 주석\n".repeat(4000);
    const at = performance.now();
    expect(join(highlight(code, "sql"))).toBe(code);
    expect(performance.now() - at).toBeLessThan(1500);
  });
});

describe("Java", () => {
  const code = [
    "@Override",
    "public static List<String> load(int n) throws IOException {",
    "  // 읽는다",
    '  String s = "a\\"b"; char c = \'x\';',
    "  long big = 1_000L; double d = 3.5e-2;",
    "  return MAX_SIZE > n ? null : this.items.stream().map(Item::name).toList();",
    "}",
    'String block = """',
    "  여러 줄",
    '  """;',
  ].join("\n");
  const k = kinds(code, "java");

  it("colours keywords, types, strings, numbers and comments", () => {
    expect(k("public")).toBe("kw");
    expect(k("int")).toBe("kw");
    expect(k("List")).toBe("type");
    expect(k("String")).toBe("type");
    expect(k('"a\\"b"')).toBe("str");
    expect(k("'x'")).toBe("str");
    expect(k("1_000L")).toBe("num");
    expect(k("3.5e-2")).toBe("num");
    expect(k("// 읽는다")).toBe("com");
    expect(k("null")).toBe("lit");
    expect(k("MAX_SIZE")).toBe("lit");
  });

  it("reads annotations, calls, members and text blocks", () => {
    expect(k("@Override")).toBe("meta");
    expect(k("load")).toBe("fn");
    expect(k("map")).toBe("fn");
    expect(kinds("var l = new ArrayList<>(); var m = new HashMap();", "java")("HashMap")).toBe("type");
    expect(k("items")).toBe("text");
    expect(highlight(code, "java").some((t) => t.kind === "str" && t.text.includes("여러 줄"))).toBe(true);
  });
});

describe("Python", () => {
  const code = [
    "@dataclass",
    "class User(Base):",
    '    """문서',
    '    문자열"""',
    "    def greet(self, name: str = None) -> str:",
    "        # 인사",
    "        return f\"hi {name}\" if name else r'\\d+'",
    "",
    "x = a @ b  # 행렬 곱",
    "print(len(items), 0x1F, 1.5j, True)",
  ].join("\n");
  const k = kinds(code, "python");

  it("colours keywords, strings, comments and literals", () => {
    expect(k("class")).toBe("kw");
    expect(k("def")).toBe("kw");
    expect(k("return")).toBe("kw");
    expect(highlight(code, "python").find((t) => t.text.includes("문서"))?.kind).toBe("str");
    expect(k('f"hi {name}"')).toBe("str");
    expect(k("r'\\d+'")).toBe("str");
    expect(k("# 인사")).toBe("com");
    expect(k("True")).toBe("lit");
    expect(k("None")).toBe("lit");
    expect(k("0x1F")).toBe("num");
    expect(k("1.5j")).toBe("num");
  });

  it("tells decorators from the matrix operator and reads names", () => {
    expect(k("@dataclass")).toBe("meta");
    expect(highlight(code, "python").find((t) => t.text.includes("@") && t.text !== "@dataclass")?.kind).toBe("op");
    expect(k("User")).toBe("type");
    expect(k("greet")).toBe("fn");
    expect(k("self")).toBe("var");
    expect(k("str")).toBe("type");
    expect(k("print")).toBe("fn");
  });
});

describe("SQL", () => {
  const code = [
    "-- 이번 달 주문",
    "select o.id, count(*) as cnt, coalesce(o.memo, 'it''s') AS memo",
    "FROM orders o LEFT JOIN users u ON u.id = o.user_id",
    "WHERE o.created_at >= :from AND o.status IN ('done', 'paid') AND o.price::numeric > 10.5",
    "/* 묶음 */ GROUP BY o.id HAVING COUNT(*) > 1;",
    'CREATE TABLE "Order" (id BIGINT PRIMARY KEY, name VARCHAR(20) NOT NULL);',
  ].join("\n");
  const k = kinds(code, "sql");

  it("colours keywords in any case, types, functions and literals", () => {
    expect(k("select")).toBe("kw");
    expect(k("FROM")).toBe("kw");
    expect(k("as")).toBe("kw");
    expect(k("count")).toBe("fn");
    expect(k("coalesce")).toBe("fn");
    expect(k("BIGINT")).toBe("type");
    expect(k("VARCHAR")).toBe("type");
    expect(k("NULL")).toBe("lit");
  });

  it("reads strings with doubled quotes, comments, binds and quoted names", () => {
    expect(k("'it''s'")).toBe("str");
    expect(k("-- 이번 달 주문")).toBe("com");
    expect(k("/* 묶음 */")).toBe("com");
    expect(k(":from")).toBe("var");
    expect(k("::")).toBe("op");
    expect(k("numeric")).toBe("type");
    expect(k('"Order"')).toBe("prop");
    expect(k("10.5")).toBe("num");
    // 점 뒤의 이름은 열이다 — 낱말과 같아도(`o.status`) 칠하지 않는다.
    expect(k("id")).toBe("text");
  });
});

describe("JavaScript · TypeScript", () => {
  it("tells regex literals from division", () => {
    const t = highlight("const r = /a\\/b[/]c/gi; const q = a / b / c;", "javascript");
    expect(kindOf(t, "/a\\/b[/]c/gi")).toBe("str");
    expect(t.filter((x) => x.kind === "str")).toHaveLength(1);
  });

  it("colours inside template literal interpolations", () => {
    const t = highlight("const s = `hi ${user.name + `!${n}`} done`;", "javascript");
    expect(join(t)).toBe("const s = `hi ${user.name + `!${n}`} done`;");
    expect(kindOf(t, "`hi ")).toBe("str");
    expect(kindOf(t, "${")).toBe("punct");
    expect(kindOf(t, "user")).toBe("text");
    expect(kindOf(t, " done`")).toBe("str");
  });

  it("reads keywords, calls, classes and literals", () => {
    const k = kinds("export async function load(id) { return await fetch(`/a`).then(r => r.json()) ?? null; }", "javascript");
    expect(k("export")).toBe("kw");
    expect(k("function")).toBe("kw");
    expect(k("load")).toBe("fn");
    expect(k("fetch")).toBe("fn");
    expect(k("null")).toBe("lit");
    expect(k("=>")).toBe("op");
  });

  it("knows TypeScript types and keywords only in TypeScript", () => {
    const code = "interface User { name: string; age?: number } type Id = string | null;";
    const ts = kinds(code, "typescript");
    expect(ts("interface")).toBe("kw");
    expect(ts("string")).toBe("type");
    expect(ts("number")).toBe("type");
    expect(ts("User")).toBe("type");
    expect(ts("Id")).toBe("type");
    expect(highlight(code, "javascript").find((t) => t.text.includes("interface"))?.kind).toBe("text");
  });

  it("reads decorators and does not colour members as keywords", () => {
    const k = kinds("@Component({}) class A { x = this.default.new; }", "typescript");
    expect(k("@Component")).toBe("meta");
    expect(k("default")).toBe("text");
    expect(k("new")).toBe("text");
    expect(k("this")).toBe("kw");
  });
});

describe("JSON", () => {
  it("tells keys from string values", () => {
    const k = kinds('{ "name": "값", "n": -1.5e3, "ok": true, "x": null } // jsonc', "json");
    expect(k('"name"')).toBe("prop");
    expect(k('"값"')).toBe("str");
    expect(k("-1.5e3")).toBe("num");
    expect(k("true")).toBe("lit");
    expect(k("null")).toBe("lit");
    expect(k("// jsonc")).toBe("com");
  });
});

describe("CSS · SCSS", () => {
  const css = [
    "/* 버튼 */",
    "@media (min-width: 600px) {",
    "  .btn:hover > a[href], #main * {",
    "    color: #3a6fd8 !important;",
    "    margin: 0 auto 1.5rem;",
    "    background: url('x.png') no-repeat, var(--bg);",
    "  }",
    "}",
  ].join("\n");
  const k = kinds(css, "css");

  it("colours selectors", () => {
    expect(k(".btn")).toBe("attr");
    expect(k(":hover")).toBe("kw");
    expect(k("a")).toBe("tag");
    expect(k("[href]")).toBe("attr");
    expect(k("#main")).toBe("attr");
  });

  it("colours declarations and at-rules", () => {
    expect(k("@media")).toBe("kw");
    expect(k("min-width")).toBe("prop");
    expect(k("600px")).toBe("num");
    expect(k("color")).toBe("prop");
    expect(k("#3a6fd8")).toBe("num");
    expect(k("!important")).toBe("kw");
    expect(k("1.5rem")).toBe("num");
    expect(k("auto")).toBe("lit");
    expect(k("url")).toBe("fn");
    expect(k("'x.png'")).toBe("str");
    expect(k("--bg")).toBe("var");
    expect(k("/* 버튼 */")).toBe("com");
  });

  it("reads nested SCSS rules, variables and line comments", () => {
    const k2 = kinds("$gap: 4px; // 간격\n.card { padding: $gap; &:hover { color: red } }", "scss");
    expect(k2("$gap")).toBe("var");
    expect(k2("// 간격")).toBe("com");
    expect(k2("padding")).toBe("prop");
    expect(k2("&")).toBe("var");
    expect(k2(":hover")).toBe("kw");
    expect(k2("red")).toBe("lit");
    // 평범한 CSS 에서 `//` 는 주석이 아니다(`url(http://…)`).
    expect(highlight("a { b: url(http://x) }", "css").some((t) => t.kind === "com")).toBe(false);
  });
});

describe("HTML · XML", () => {
  const html = [
    "<!DOCTYPE html>",
    "<!-- 머리 -->",
    '<div class="box" data-id=3 hidden>',
    "  안녕 &amp; 반가워",
    '  <script type="module">const a = 1; if (a < 2) {}</script>',
    "  <style>.box { color: red; }</style>",
    "</div>",
  ].join("\n");
  const k = kinds(html, "html");

  it("colours tags, attributes, values, entities and comments", () => {
    expect(k("<!DOCTYPE html>")).toBe("meta");
    expect(k("<!-- 머리 -->")).toBe("com");
    expect(k("div")).toBe("tag");
    expect(k("class")).toBe("attr");
    expect(k('"box"')).toBe("str");
    expect(k("3")).toBe("str");
    expect(k("hidden")).toBe("attr");
    expect(k("&amp;")).toBe("lit");
  });

  it("colours <script> as JavaScript and <style> as CSS", () => {
    expect(k("const")).toBe("kw");
    expect(k("if")).toBe("kw");
    expect(k("color")).toBe("prop");
    expect(k(".box")).toBe("attr");
    expect(k("script", 1)).toBe("tag");
    expect(join(highlight(html, "html"))).toBe(html);
  });

  it("finds the end of a script case-insensitively without drifting on wide lowercase letters", () => {
    const html = "<p>İİ</p><SCRIPT>let x = 1</Script><b>뒤</b>";
    const t = highlight(html, "html");
    expect(join(t)).toBe(html);
    expect(kindOf(t, "let")).toBe("kw");
    expect(kindOf(t, "b")).toBe("tag");
  });

  it("leaves template scripts as text and reads XML", () => {
    expect(
      highlight('<script type="text/template"><b>{{x}}</b></script>', "html").some((t) => t.text.includes("<b>{{x}}</b>")),
    ).toBe(true);
    const x = kinds('<?xml version="1.0"?><bean id="a"><![CDATA[ x < y ]]></bean>', "xml");
    expect(x('<?xml version="1.0"?>')).toBe("meta");
    expect(x("bean")).toBe("tag");
    expect(x("<![CDATA[ x < y ]]>")).toBe("str");
  });
});
