/**
 * 코드 블록의 문법 강조 — 마크다운 뷰어의 코드 카드(`CodeCard`)가 쓴다.
 *
 * 펜스에 언어를 적은 블록(```` ```java ````)만 강조하고, 언어가 없거나 여기서 모르는 언어면
 * `null` 을 돌려 예전처럼 한 가지 색으로 그린다. 다루는 언어는 업무 노트에 실제로 들어오는
 * 것들이다 — Java · Python · SQL 과 웹 언어(HTML · XML · CSS · SCSS · JavaScript · TypeScript ·
 * JSON).
 *
 * 라이브러리를 쓰지 않고 언어마다 작은 어휘 분석기를 둔다. 읽는 화면의 색칠이라 파서만큼
 * 정확할 필요는 없고, 대신 두 가지는 반드시 지킨다.
 *
 * * **글자를 잃지 않는다.** 토큰을 이어 붙이면 언제나 원문 그대로다 — 강조가 틀려도 코드는
 *   바뀌지 않는다. 모르는 글자는 한 글자씩 보통 글자로 넘긴다.
 * * **HTML 로 만들지 않는다.** 토큰은 종류와 글자뿐이고, 뷰어가 React 의 글자로 그린다
 *   (`dangerouslySetInnerHTML` 없음). 코드에 무엇이 들어 있어도 화면에 스크립트가 끼지 않는다.
 */

export type TokenKind =
  | "text"
  | "kw"
  | "type"
  | "fn"
  | "str"
  | "num"
  | "lit"
  | "com"
  | "meta"
  | "tag"
  | "attr"
  | "prop"
  | "var"
  | "op"
  | "punct";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type CodeLang =
  | "java"
  | "python"
  | "sql"
  | "javascript"
  | "typescript"
  | "html"
  | "xml"
  | "css"
  | "scss"
  | "json";

export interface CodeLangInfo {
  lang: CodeLang;
  /** 카드 머리띠에 적는 이름. */
  label: string;
  /**
   * 머리띠의 언어 점 색. 언어마다 흔히 쓰는 색(GitHub linguist)이되, 보라는 피한다 — 이 앱에서
   * 보라는 AI 전용이다(`design.ts`). 그래서 CSS 는 linguist 의 보라 대신 로고의 파랑이다.
   */
  dot: string;
}

const INFO: Record<CodeLang, Omit<CodeLangInfo, "lang">> = {
  java: { label: "Java", dot: "#b07219" },
  python: { label: "Python", dot: "#3572a5" },
  sql: { label: "SQL", dot: "#e38c00" },
  javascript: { label: "JavaScript", dot: "#e0c341" },
  typescript: { label: "TypeScript", dot: "#3178c6" },
  html: { label: "HTML", dot: "#e34c26" },
  xml: { label: "XML", dot: "#0060ac" },
  css: { label: "CSS", dot: "#2965f1" },
  scss: { label: "SCSS", dot: "#c6538c" },
  json: { label: "JSON", dot: "#6a665e" },
};

/** 펜스에 적는 여러 이름. 대소문자는 가리지 않는다. */
const ALIAS: Record<string, CodeLang> = {
  java: "java",
  python: "python",
  py: "python",
  python3: "python",
  py3: "python",
  sql: "sql",
  mysql: "sql",
  mariadb: "sql",
  postgres: "sql",
  postgresql: "sql",
  pgsql: "sql",
  psql: "sql",
  plsql: "sql",
  tsql: "sql",
  mssql: "sql",
  oracle: "sql",
  sqlite: "sql",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "scss",
  json: "json",
  jsonc: "json",
  json5: "json",
};

/** 펜스의 언어 낱말(`lang`)을 읽는다. 모르는 언어 · 빈 문자열이면 `null` — 강조하지 않는다. */
export function codeLang(word: string): CodeLangInfo | null {
  const key = word
    .trim()
    .toLowerCase()
    .replace(/^[{.]+|[}]+$/g, "");
  const lang = ALIAS[key];
  return lang ? { lang, ...INFO[lang] } : null;
}

/** 이보다 긴 블록은 강조하지 않는다 — 수만 줄짜리 로그를 칠하느라 뷰어가 멈추지 않게. */
export const HIGHLIGHT_LIMIT = 200_000;

// ---------------------------------------------------------------------------
// 공통 바탕.

class Lexer {
  pos = 0;
  readonly out: Token[] = [];
  /**
   * 마지막으로 낸 의미 있는 조각(공백 · 주석이 아닌 것 — 보통 글자인 이름도 든다). 정규식 ·
   * 이름의 뜻을 가르는 데 쓴다. `a / b` 의 `/` 가 정규식이 아닌 것은 앞의 `a` 를 알기 때문이다.
   */
  last: Token | null = null;

  constructor(readonly src: string) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(n = 0): string {
    return this.src[this.pos + n] ?? "";
  }

  /** `re` 는 `y`(sticky) 정규식이어야 한다. 빈 일치는 일치로 치지 않는다 — 제자리걸음을 막는다. */
  at(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    return m && m[0] ? m : null;
  }

  emit(kind: TokenKind, text: string): void {
    if (!text) return;
    const prev = this.out[this.out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else this.out.push({ kind, text });
    this.pos += text.length;
    if (kind !== "com" && text.trim()) this.last = { kind, text };
  }

  /** `end` 자리까지를 한 토큰으로 낸다. */
  emitTo(kind: TokenKind, end: number): void {
    this.emit(kind, this.src.slice(this.pos, Math.max(this.pos, end)));
  }

  /** 다른 언어로 칠한 조각(HTML 안의 `<script>` 등)을 이어 붙인다. */
  append(tokens: Token[]): void {
    for (const t of tokens) this.emit(t.kind, t.text);
  }

  /** 지금 자리 뒤로 공백을 건너 처음 나오는 글자. */
  nextNonSpace(from = this.pos): string {
    const m = /\s*/y;
    m.lastIndex = from;
    m.exec(this.src);
    return this.src[m.lastIndex] ?? "";
  }

  /** 지금 자리가 줄의 첫 글자(앞에 공백뿐)인지. */
  lineStart(): boolean {
    const nl = this.src.lastIndexOf("\n", this.pos - 1);
    return !this.src.slice(nl + 1, this.pos).trim();
  }
}

const set = (words: string): Set<string> => new Set(words.split(/\s+/).filter(Boolean));

const WS = /\s+/y;
const IDENT = /[A-Za-z_$À-￿][\w$À-￿]*/y;
const CONST_NAME = /^[A-Z][A-Z0-9_]+$/;
const PUNCT = /[()[\]{};,.]/y;

/** 바로 앞이 멤버 접근(`.` · `?.`)인지. 펼치기(`...`)는 아니다. */
function afterDot(prev: Token | null): boolean {
  return !!prev && (prev.kind === "punct" || prev.kind === "op") && /(?:^|[^.])\.$/.test(prev.text);
}

/** 이름 하나의 종류 — 언어마다 다른 부분만 `kw` · `lit` · `type` · `builtin` 으로 넘긴다. */
function nameKind(
  lx: Lexer,
  name: string,
  end: number,
  sets: { kw: Set<string>; lit: Set<string>; type?: Set<string>; builtin?: Set<string> },
): TokenKind {
  const prev = lx.last;
  // `obj.default` · `x.class` 처럼 점 뒤의 이름은 낱말이 아니라 속성이다.
  const member = afterDot(prev);
  const call = lx.nextNonSpace(end) === "(";
  if (!member) {
    if (sets.lit.has(name)) return "lit";
    if (sets.kw.has(name)) return "kw";
    if (sets.type?.has(name)) return "type";
    if (sets.builtin?.has(name)) return call ? "fn" : "type";
  }
  // 선언하는 이름 · 생성자가 먼저다 — `class User(Base):` 의 `User` 는 괄호가 붙어도 부르는
  // 것이 아니고, `new Foo()` 의 `Foo` 는 클래스다.
  if (prev?.kind === "kw" && /^(?:class|interface|enum|record|extends|implements|new|type|struct)$/.test(prev.text))
    return "type";
  if (prev?.kind === "kw" && /^(?:def|function)$/.test(prev.text)) return "fn";
  if (call) return "fn";
  if (CONST_NAME.test(name)) return "lit";
  if (/^[A-Z]/.test(name)) return "type";
  return "text";
}

// ---------------------------------------------------------------------------
// Java.

const JAVA_KW = set(`
  abstract assert break case catch class const continue default do else enum extends final finally
  for goto if implements import instanceof interface native new package private protected public
  return static strictfp super switch synchronized this throw throws transient try volatile while
  var record sealed permits yield non-sealed module requires exports opens uses provides with to
  boolean byte char short int long float double void`);
const JAVA_LIT = set("true false null");

function lexJava(lx: Lexer): void {
  const sets = { kw: JAVA_KW, lit: JAVA_LIT };
  let m: RegExpExecArray | null;
  while (!lx.done) {
    if ((m = lx.at(WS))) lx.emit("text", m[0]);
    else if ((m = lx.at(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y))) lx.emit("com", m[0]);
    else if ((m = lx.at(/"""[\s\S]*?(?:"""|$)/y))) lx.emit("str", m[0]);
    else if ((m = lx.at(/"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/y))) lx.emit("str", m[0]);
    else if ((m = lx.at(/@(?!interface\b)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y))) lx.emit("meta", m[0]);
    else if (
      (m = lx.at(
        /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[lLfFdD]?\b/y,
      ))
    )
      lx.emit("num", m[0]);
    else if ((m = lx.at(IDENT))) lx.emit(nameKind(lx, m[0], lx.pos + m[0].length, sets), m[0]);
    else if ((m = lx.at(/->|::|[-+*/%=&|^~!<>?:@]+/y))) lx.emit("op", m[0]);
    else if ((m = lx.at(PUNCT))) lx.emit("punct", m[0]);
    else lx.emit("text", lx.peek());
  }
}

// ---------------------------------------------------------------------------
// Python.

const PY_KW = set(`
  and as assert async await break class continue def del elif else except finally for from global
  if import in is lambda nonlocal not or pass raise return try while with yield match case`);
const PY_LIT = set("True False None NotImplemented Ellipsis __name__ __main__ __file__");
const PY_BUILTIN = set(`
  abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex
  delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr
  hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next
  object oct open ord pow print property range repr reversed round set setattr slice sorted
  staticmethod str sum super tuple type vars zip Exception BaseException ValueError TypeError
  KeyError IndexError RuntimeError StopIteration AttributeError ImportError OSError IOError
  FileNotFoundError NotImplementedError ZeroDivisionError AssertionError`);

function lexPython(lx: Lexer): void {
  const sets = { kw: PY_KW, lit: PY_LIT, builtin: PY_BUILTIN };
  let m: RegExpExecArray | null;
  while (!lx.done) {
    if ((m = lx.at(WS))) lx.emit("text", m[0]);
    else if ((m = lx.at(/#[^\n]*/y))) lx.emit("com", m[0]);
    else if ((m = lx.at(/(?:[rRbBuUfF]{1,2})?("""|''')[\s\S]*?(?:\1|$)/y))) lx.emit("str", m[0]);
    else if ((m = lx.at(/(?:[rRbBuUfF]{1,2})?(["'])(?:\\[\s\S]|(?!\1)[^\\\n])*\1?/y))) lx.emit("str", m[0]);
    // `@` 은 줄 맨 앞일 때만 데코레이터다 — 줄 가운데의 `a @ b` 는 행렬 곱이다.
    else if (lx.peek() === "@" && lx.lineStart() && (m = lx.at(/@[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/y)))
      lx.emit("meta", m[0]);
    else if (
      (m = lx.at(
        /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)\b/y,
      ))
    )
      lx.emit("num", m[0]);
    else if ((m = lx.at(IDENT))) {
      const name = m[0];
      lx.emit(
        !afterDot(lx.last) && (name === "self" || name === "cls") ? "var" : nameKind(lx, name, lx.pos + name.length, sets),
        name,
      );
    } else if ((m = lx.at(/->|:=|\*\*=?|\/\/=?|[-+*/%=&|^~!<>@:]+/y))) lx.emit("op", m[0]);
    else if ((m = lx.at(PUNCT))) lx.emit("punct", m[0]);
    else lx.emit("text", lx.peek());
  }
}

// ---------------------------------------------------------------------------
// SQL — 낱말의 대소문자를 가리지 않는다.

const SQL_KW = set(`
  ADD ALL ALTER ANALYZE AND ANY AS ASC AUTHORIZATION AUTO_INCREMENT BEGIN BETWEEN BY CALL CASCADE
  CASE CHECK COLLATE COLUMN COMMENT COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT_DATE
  CURRENT_TIME CURRENT_TIMESTAMP CURSOR DATABASE DECLARE DEFAULT DELETE DESC DISTINCT DO DROP EACH
  ELSE ELSIF END ESCAPE EXCEPT EXCEPTION EXEC EXECUTE EXISTS EXPLAIN FETCH FILTER FIRST FOR FOREIGN
  FROM FULL FUNCTION GRANT GROUP HAVING IF ILIKE IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY
  LANGUAGE LAST LATERAL LEFT LIKE LIMIT LOOP MERGE MATCHED MINUS NATURAL NEXT NO NOT NOTHING NULLS
  OF OFFSET ON ONLY OR ORDER OUTER OVER PARTITION PRECEDING PRIMARY PROCEDURE RANGE RECURSIVE
  REFERENCES REPLACE RESTRICT RETURN RETURNING RETURNS REVOKE RIGHT ROLLBACK ROW ROWS ROWNUM
  SAVEPOINT SCHEMA SELECT SEQUENCE SET SHOW SOME START TABLE TEMP TEMPORARY THEN TO TOP TRANSACTION
  TRIGGER TRUNCATE UNBOUNDED UNION UNIQUE UPDATE USE USING VACUUM VALUES VIEW WHEN WHERE WHILE
  WINDOW WITH WITHOUT CONNECT PRIOR NOCYCLE SIBLINGS PIVOT UNPIVOT DUAL GO`);
const SQL_TYPE = set(`
  BIGINT BINARY BIT BLOB BOOL BOOLEAN BYTEA CHAR CHARACTER CLOB DATE DATETIME DATETIME2 DEC DECIMAL
  DOUBLE ENUM FLOAT INT INT2 INT4 INT8 INTEGER INTERVAL JSON JSONB LONG LONGTEXT MEDIUMINT
  MEDIUMTEXT MONEY NCHAR NCLOB NUMBER NUMERIC NVARCHAR NVARCHAR2 PRECISION RAW REAL SERIAL
  BIGSERIAL SMALLINT TEXT TIME TIMESTAMP TIMESTAMPTZ TINYINT TINYTEXT UUID VARBINARY VARCHAR
  VARCHAR2 XML YEAR ZONE`);
const SQL_LIT = set("NULL TRUE FALSE UNKNOWN");

function lexSql(lx: Lexer): void {
  let m: RegExpExecArray | null;
  while (!lx.done) {
    if ((m = lx.at(WS))) lx.emit("text", m[0]);
    else if ((m = lx.at(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y))) lx.emit("com", m[0]);
    // 표준 SQL 은 따옴표를 둘 적어 막는다(`'it''s'`). 백슬래시는 글자 그대로다.
    else if ((m = lx.at(/[nNeE]?'(?:''|[^'])*'?/y))) lx.emit("str", m[0]);
    // PostgreSQL 의 달러 따옴표 — 함수 본문이 통째로 들어간다.
    else if ((m = lx.at(/\$([A-Za-z_]\w*)?\$[\s\S]*?(?:\$\1\$|$)/y))) lx.emit("str", m[0]);
    else if ((m = lx.at(/"(?:""|[^"])*"?|`(?:``|[^`])*`?|\[[^\]\n]*\]/y))) lx.emit("prop", m[0]);
    else if ((m = lx.at(/::/y))) lx.emit("op", m[0]);
    // 바인드 변수 · 세션 변수 — `:name` · `@name` · `@@ROWCOUNT` · `$1` · `?`.
    else if ((m = lx.at(/@@?[A-Za-z_]\w*|:[A-Za-z_]\w*|\$\d+|\?/y))) lx.emit("var", m[0]);
    else if ((m = lx.at(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\b/y))) lx.emit("num", m[0]);
    else if ((m = lx.at(IDENT))) {
      const up = m[0].toUpperCase();
      const member = afterDot(lx.last);
      const call = lx.nextNonSpace(lx.pos + m[0].length) === "(";
      const kind: TokenKind = member
        ? "text"
        : SQL_LIT.has(up)
          ? "lit"
          : SQL_KW.has(up)
            ? "kw"
            : SQL_TYPE.has(up)
              ? "type"
              : call
                ? "fn"
                : "text";
      lx.emit(kind, m[0]);
    } else if ((m = lx.at(/\|\||<>|[<>!=]=|[-+*/%=<>!|&^~]/y))) lx.emit("op", m[0]);
    else if ((m = lx.at(PUNCT))) lx.emit("punct", m[0]);
    else lx.emit("text", lx.peek());
  }
}

// ---------------------------------------------------------------------------
// JavaScript · TypeScript.

const JS_KW = set(`
  async await break case catch class const continue debugger default delete do else export extends
  finally for from function if import in instanceof let new of return static super switch
  this throw try typeof var void while with yield as`);
const TS_KW = set(`
  abstract declare enum implements interface is keyof namespace module private protected public
  readonly satisfies type infer override unique asserts accessor`);
const TS_TYPE = set("any bigint boolean never number object string symbol unknown void undefined");
const JS_LIT = set("true false null undefined NaN Infinity");
const JS_BUILTIN = set("console window document globalThis process require module exports");
/** 이 낱말 뒤의 `/` 는 나누기가 아니라 정규식이 시작하는 자리다. */
const REGEX_AFTER_KW = set("return typeof instanceof in of new delete void throw case do else yield await");

function regexAllowed(last: Token | null): boolean {
  if (!last) return true;
  if (last.kind === "op") return true;
  if (last.kind === "punct") return !/[)\]}.]$/.test(last.text);
  if (last.kind === "kw") return REGEX_AFTER_KW.has(last.text);
  return false;
}

/**
 * `stopAtBrace` 면 짝이 맞지 않는 `}` 앞에서 멈춘다 — 템플릿 문자열의 `${…}` 안을 칠할 때.
 */
function lexJs(lx: Lexer, ts: boolean, stopAtBrace = false): void {
  const kw = ts ? new Set([...JS_KW, ...TS_KW]) : JS_KW;
  const sets = { kw, lit: JS_LIT, type: ts ? TS_TYPE : undefined, builtin: JS_BUILTIN };
  let depth = 0;
  let m: RegExpExecArray | null;
  while (!lx.done) {
    const c = lx.peek();
    if (stopAtBrace) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (!depth) return;
        depth--;
      }
    }
    if ((m = lx.at(WS))) lx.emit("text", m[0]);
    else if ((m = lx.at(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y))) lx.emit("com", m[0]);
    else if (c === "`") template(lx, ts);
    else if ((m = lx.at(/(["'])(?:\\[\s\S]|(?!\1)[^\\\n])*\1?/y))) lx.emit("str", m[0]);
    else if (c === "/" && regexAllowed(lx.last) && (m = lx.at(/\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/y)))
      lx.emit("str", m[0]);
    else if (
      (m = lx.at(
        /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?\b/y,
      ))
    )
      lx.emit("num", m[0]);
    else if ((m = lx.at(/@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y))) lx.emit("meta", m[0]);
    else if ((m = lx.at(/#?[A-Za-z_$À-￿][\w$À-￿]*/y))) {
      const name = m[0];
      lx.emit(name.startsWith("#") ? "text" : nameKind(lx, name, lx.pos + name.length, sets), name);
    } else if ((m = lx.at(/=>|\.\.\.|\?\?=?|\?\.(?!\d)|[-+*/%=&|^~!<>?:]+/y))) lx.emit("op", m[0]);
    else if ((m = lx.at(PUNCT))) lx.emit("punct", m[0]);
    else lx.emit("text", c);
  }
}

/** 백틱 문자열. `${…}` 안은 다시 JavaScript 로 칠한다. */
function template(lx: Lexer, ts: boolean): void {
  const s = lx.src;
  let i = lx.pos + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      lx.emitTo("str", i + 1);
      return;
    }
    if (ch === "$" && s[i + 1] === "{") {
      lx.emitTo("str", i);
      lx.emit("punct", "${");
      lexJs(lx, ts, true);
      if (lx.peek() === "}") lx.emit("punct", "}");
      i = lx.pos;
      continue;
    }
    i++;
  }
  lx.emitTo("str", s.length);
}

// ---------------------------------------------------------------------------
// JSON.

function lexJson(lx: Lexer): void {
  let m: RegExpExecArray | null;
  while (!lx.done) {
    if ((m = lx.at(WS))) lx.emit("text", m[0]);
    else if ((m = lx.at(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y))) lx.emit("com", m[0]);
    else if ((m = lx.at(/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y)))
      // 뒤에 `:` 가 오면 키다.
      lx.emit(lx.nextNonSpace(lx.pos + m[0].length) === ":" ? "prop" : "str", m[0]);
    else if ((m = lx.at(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y))) lx.emit("num", m[0]);
    else if ((m = lx.at(/\b(?:true|false|null)\b/y))) lx.emit("lit", m[0]);
    else if ((m = lx.at(/[A-Za-z_$][\w$]*/y)))
      // JSON5 의 따옴표 없는 키.
      lx.emit(lx.nextNonSpace(lx.pos + m[0].length) === ":" ? "prop" : "text", m[0]);
    else if ((m = lx.at(/[{}[\],:]/y))) lx.emit("punct", m[0]);
    else lx.emit("text", lx.peek());
  }
}

// ---------------------------------------------------------------------------
// CSS · SCSS.

/**
 * 문장이 선택자인지 선언인지 — 앞으로 읽어 `{` 가 `;` · `}` 보다 먼저 나오면 선택자다. 중첩된
 * 규칙(SCSS · 요즘 CSS)도 이것으로 가른다. 끝까지 아무것도 없으면 `:` 가 있을 때 선언이다.
 */
function cssIsSelector(src: string, from: number): boolean {
  let colon = false;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") return true;
    if (ch === ";" || ch === "}") return false;
    if (ch === ":") colon = true;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
    }
  }
  return !colon;
}

function lexCss(lx: Lexer, scss: boolean): void {
  /** `start` — 문장 첫머리, `sel` — 선택자, `prop` — 속성 이름, `value` — 값 · @규칙의 머리. */
  let mode: "start" | "sel" | "prop" | "value" = "start";
  let m: RegExpExecArray | null;
  const COMMENT = scss ? /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y : /\/\*[\s\S]*?(?:\*\/|$)/y;
  while (!lx.done) {
    if ((m = lx.at(WS))) {
      lx.emit("text", m[0]);
      continue;
    }
    if ((m = lx.at(COMMENT))) {
      lx.emit("com", m[0]);
      continue;
    }
    if (mode === "start") {
      if (lx.peek() === "@") {
        m = lx.at(/@[\w-]+/y);
        if (m) {
          lx.emit("kw", m[0]);
          mode = "value";
          continue;
        }
      }
      mode = cssIsSelector(lx.src, lx.pos) ? "sel" : "prop";
    }
    const c = lx.peek();
    if (c === "{" || c === "}" || c === ";") {
      lx.emit("punct", c);
      mode = "start";
      continue;
    }
    if ((m = lx.at(/"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/y))) {
      lx.emit("str", m[0]);
      continue;
    }
    if (mode === "sel") {
      if ((m = lx.at(/::?[\w-]+/y))) lx.emit("kw", m[0]);
      else if ((m = lx.at(/[.#][\w-]+|%[\w-]+/y))) lx.emit("attr", m[0]);
      else if ((m = lx.at(/\[[^\]\n]*\]?/y))) lx.emit("attr", m[0]);
      else if ((m = lx.at(/[\w-]+|\*/y))) lx.emit("tag", m[0]);
      else if ((m = lx.at(/&|\$[\w-]+/y))) lx.emit("var", m[0]);
      else if ((m = lx.at(/[>+~,()]/y))) lx.emit("op", m[0]);
      else lx.emit("text", c);
      continue;
    }
    if (mode === "prop") {
      if ((m = lx.at(/--[\w-]+|\$[\w-]+|-?[A-Za-z_][\w-]*/y))) lx.emit(m[0].startsWith("$") ? "var" : "prop", m[0]);
      else if (c === ":") {
        lx.emit("punct", c);
        mode = "value";
      } else lx.emit("text", c);
      continue;
    }
    // 값.
    if ((m = lx.at(/#[\da-fA-F]{3,8}\b/y))) lx.emit("num", m[0]);
    else if ((m = lx.at(/[-+]?(?:\d*\.\d+|\d+)(?:%|[A-Za-z]+)?/y))) lx.emit("num", m[0]);
    else if ((m = lx.at(/!important\b|!default\b/y))) lx.emit("kw", m[0]);
    else if ((m = lx.at(/--[\w-]+|\$[\w-]+/y))) lx.emit("var", m[0]);
    else if ((m = lx.at(/-?[A-Za-z_][\w-]*/y))) {
      const next = lx.src[lx.pos + m[0].length];
      lx.emit(next === "(" ? "fn" : next === ":" ? "prop" : "lit", m[0]);
    } else if ((m = lx.at(/[(),/:]/y))) lx.emit("punct", m[0]);
    else lx.emit("text", c);
  }
}

// ---------------------------------------------------------------------------
// HTML · XML.

function lexMarkup(lx: Lexer, html: boolean): void {
  let m: RegExpExecArray | null;
  while (!lx.done) {
    if ((m = lx.at(/<!--[\s\S]*?(?:-->|$)/y))) lx.emit("com", m[0]);
    else if ((m = lx.at(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y))) lx.emit("str", m[0]);
    else if ((m = lx.at(/<![^>]*>?|<\?[\s\S]*?(?:\?>|$)/y))) lx.emit("meta", m[0]);
    else if ((m = lx.at(/<\/?(?=[A-Za-z])/y))) {
      const closing = m[0] === "</";
      lx.emit("punct", m[0]);
      const name = lx.at(/[A-Za-z][\w:.-]*/y)?.[0] ?? "";
      lx.emit("tag", name);
      let typeAttr = "";
      // 태그 안 — 속성 이름 · 값.
      while (!lx.done) {
        if ((m = lx.at(WS))) lx.emit("text", m[0]);
        else if ((m = lx.at(/\/?>/y))) {
          lx.emit("punct", m[0]);
          break;
        } else if ((m = lx.at(/[^\s"'>/=]+/y))) {
          const attr = m[0];
          lx.emit("attr", attr);
          const eq = lx.at(/\s*=\s*/y);
          if (eq) {
            lx.emit("op", eq[0]);
            const v = lx.at(/"[^"]*"?|'[^']*'?|[^\s"'=<>`]+/y);
            if (v) {
              if (attr.toLowerCase() === "type") typeAttr = v[0].replace(/["']/g, "").toLowerCase();
              lx.emit("str", v[0]);
            }
          }
        } else if (lx.peek() === "<") break; // 닫히지 않은 태그 — 다음 태그로 넘어간다.
        else lx.emit("punct", lx.peek());
      }
      // `<script>` · `<style>` 의 안은 그 언어로 칠한다.
      const lower = name.toLowerCase();
      if (html && !closing && (lower === "script" || lower === "style") && lx.src[lx.pos - 1] === ">") {
        // 대소문자를 무시해 찾는다. 문서 전체를 `toLowerCase()` 하면 길이가 바뀌는 글자(`İ`)에서
        // 자리가 어긋난다.
        const re = new RegExp(`</${lower}`, "gi");
        re.lastIndex = lx.pos;
        const end = re.exec(lx.src)?.index ?? lx.src.length;
        const body = lx.src.slice(lx.pos, end);
        if (body) {
          // `type="text/template"` 같은 것은 스크립트가 아니라 글이다.
          const plain = /^text\/(?:template|html|x-template)$/.test(typeAttr);
          const sub: CodeLang =
            lower === "style"
              ? "css"
              : typeAttr.includes("json")
                ? "json"
                : /typescript/.test(typeAttr)
                  ? "typescript"
                  : "javascript";
          lx.append(plain ? [{ kind: "text", text: body }] : highlight(body, sub));
        }
      }
    } else if ((m = lx.at(/&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][\w]*);/y))) lx.emit("lit", m[0]);
    else if ((m = lx.at(/[^<&]+/y))) lx.emit("text", m[0]);
    else lx.emit("text", lx.peek());
  }
}

// ---------------------------------------------------------------------------

/**
 * `code` 를 `lang` 의 토큰으로 자른다. 토큰의 글을 이어 붙이면 언제나 `code` 그대로다.
 * 이웃한 같은 종류의 토큰은 하나로 합친다(그리는 span 을 줄인다).
 */
export function highlight(code: string, lang: CodeLang): Token[] {
  const lx = new Lexer(code);
  switch (lang) {
    case "java":
      lexJava(lx);
      break;
    case "python":
      lexPython(lx);
      break;
    case "sql":
      lexSql(lx);
      break;
    case "javascript":
      lexJs(lx, false);
      break;
    case "typescript":
      lexJs(lx, true);
      break;
    case "json":
      lexJson(lx);
      break;
    case "css":
      lexCss(lx, false);
      break;
    case "scss":
      lexCss(lx, true);
      break;
    case "html":
      lexMarkup(lx, true);
      break;
    case "xml":
      lexMarkup(lx, false);
      break;
  }
  // 멈춘 분석기가 있어도 남은 글자는 잃지 않는다.
  if (!lx.done) lx.emit("text", code.slice(lx.pos));
  return lx.out;
}
