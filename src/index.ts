/**
 * URI template library with partial expansion support.
 *
 * Expansion follows RFC 6570 (levels 1-4).  Partial expansion keeps unknown
 * variables inside the expression AST instead of degrading the template to a
 * concatenated string: known variables become frozen, already-encoded terms
 * while unknown variable specs stay in place (keeping their explode / prefix
 * modifiers) and can be resolved in later rounds.
 */

export type VariableValue = string | number | boolean | string[] | Record<string, string>;
export type Variables = Record<
  string,
  string | number | boolean | string[] | Record<string, string> | undefined
>;

/** RFC 6570 operators plus the empty (simple) operator. */
export type Operator = '' | '+' | '#' | '.' | '/' | ';' | '?' | '&';

/** A single variable specification as it appears in an expression. */
export interface VarSpec {
  name: string;
  explode: boolean;
  /** Prefix modifier length (`:n`), or undefined when absent. */
  prefix?: number;
}

/**
 * A term inside an expanded expression.
 *
 * - `pending`: the variable has never been provided; its spec is retained.
 * - `missing`: the variable was explicitly provided as `undefined`; it has
 *   been decided and must never come back in a later round.
 * - `text`: a frozen, already-encoded contribution of a known variable, with
 *   no leading separator (separators are derived at render time, so the
 *   consumed operator-prefix state can never be emitted twice).
 */
export type Term =
  | { kind: 'pending'; name: string; explode: boolean; prefix?: number }
  | { kind: 'missing'; name: string }
  | { kind: 'text'; name: string; body: string };

export interface LiteralNode {
  type: 'literal';
  value: string;
}

export interface ExpressionNode {
  type: 'expression';
  operator: Operator;
  /** Variable specs in template order (the retained specification list). */
  specs: VarSpec[];
  /** Per-variable expansion state, in template order. */
  terms: Term[];
  /**
   * Consumed-separator state: true once a known variable has contributed,
   * i.e. the operator prefix (or first separator) is "in use".
   */
  started: boolean;
}

export type Node = LiteralNode | ExpressionNode;
export type Template = Node[];

interface OpMeta {
  /** Operator prefix emitted before the first contributing variable. */
  prefix: string;
  /** Separator between contributing variables. */
  sep: string;
  /** Named expansion: emit `name=`. */
  named: boolean;
  /** Reserved expansion: leave reserved characters unencoded. */
  reserved: boolean;
  /** Expansion for an empty value in a named operator (`=` for ?/&, `` for ;). */
  ifemp: string;
  /** Separator character used inside an exploded composite. */
  innerSep: string;
}

const OPS: Record<Operator, OpMeta> = {
  '':  { prefix: '',  sep: ',', named: false, reserved: false, ifemp: '',  innerSep: ',' },
  '+': { prefix: '',  sep: ',', named: false, reserved: true,  ifemp: '',  innerSep: ',' },
  '#': { prefix: '#', sep: ',', named: false, reserved: true,  ifemp: '',  innerSep: ',' },
  '.': { prefix: '.', sep: '.', named: false, reserved: false, ifemp: '',  innerSep: '.' },
  '/': { prefix: '/', sep: '/', named: false, reserved: false, ifemp: '',  innerSep: '/' },
  ';': { prefix: ';', sep: ';', named: true,  reserved: false, ifemp: '',  innerSep: ';' },
  '?': { prefix: '?', sep: '&', named: true,  reserved: false, ifemp: '=',  innerSep: '&' },
  '&': { prefix: '&', sep: '&', named: true,  reserved: false, ifemp: '=',  innerSep: '&' },
};

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
);
const RESERVED = new Set(":/?#[]@!$&'()*+,;=");

function encodeCodePoint(code: number, reserved: boolean): string {
  if (code < 128) {
    const ch = String.fromCharCode(code);
    if (UNRESERVED.has(ch) || (reserved && RESERVED.has(ch))) return ch;
    return '%' + code.toString(16).toUpperCase().padStart(2, '0');
  }
  // Encode the UTF-8 bytes of a supplementary / multibyte code point.
  const bytes = Buffer.from(String.fromCodePoint(code), 'utf8');
  let out = '';
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

const HEXDIG = '0123456789ABCDEFabcdef';

function isHex(ch: string | undefined): boolean {
  return ch !== undefined && HEXDIG.includes(ch);
}

function pctEncode(input: string, reserved: boolean): string {
  let out = '';
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    // A valid percent-triplet is literal text for reserved expansion
    // ({+var}, {#var}) and encoded as "%25.." otherwise.
    if (ch === '%' && isHex(input[i + 1]) && isHex(input[i + 2])) {
      if (reserved) {
        out += input.slice(i, i + 3);
        i += 3;
        continue;
      }
      out += '%25' + input[i + 1] + input[i + 2];
      i += 3;
      continue;
    }
    const cp = input.codePointAt(i)!;
    out += encodeCodePoint(cp, reserved);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

/**
 * Encode literal template text (RFC 6570 section 2.1): unreserved characters,
 * reserved characters and valid percent-triplets survive; everything else
 * (including non-ASCII text) is UTF-8 percent-encoded.
 */
function encodeLiteral(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    if (ch === '%' && isHex(input[i + 1]) && isHex(input[i + 2])) {
      out += input.slice(i, i + 3);
      i += 3;
      continue;
    }
    const cpLit = input.codePointAt(i)!;
    if (cpLit < 128 && (UNRESERVED.has(ch) || RESERVED.has(ch))) {
      out += ch;
      i += 1;
    } else {
      out += encodeCodePoint(cpLit, false);
      i += cpLit > 0xffff ? 2 : 1;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const SPEC_RE = /^([a-zA-Z0-9_]+)(\*)?(?::([0-9]+))?$/;

function parseSpec(raw: string): VarSpec {
  const m = SPEC_RE.exec(raw);
  if (!m) return { name: raw, explode: false };
  return {
    name: m[1],
    explode: m[2] === '*',
    prefix: m[3] !== undefined ? Number(m[3]) : undefined,
  };
}

function parseExpression(inner: string): ExpressionNode {
  let operator: Operator = '';
  if (inner.length > 0 && '+#./;?&'.includes(inner[0])) {
    operator = inner[0] as Operator;
    inner = inner.slice(1);
  }
  const specs = inner.split(',').map(parseSpec);
  return {
    type: 'expression',
    operator,
    specs,
    terms: specs.map((s) => ({ kind: 'pending', name: s.name, explode: s.explode, prefix: s.prefix })),
    started: false,
  };
}

/** Parse a URI template string into an AST. */
export function parse(template: string): Template {
  const nodes: Template = [];
  let literal = '';
  const flush = () => {
    if (literal) {
      nodes.push({ type: 'literal', value: literal });
      literal = '';
    }
  };
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        literal += ch;
        continue;
      }
      flush();
      nodes.push(parseExpression(template.slice(i + 1, end)));
      i = end;
    } else {
      literal += ch;
    }
  }
  flush();
  return nodes;
}

/* -------------------------------------------------------------------------- */
/* Expansion of one known variable                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render the body (no leading separator or operator prefix) of a known
 * variable.  Empty composites and explicit undefined values return null,
 * meaning the variable contributes nothing.
 */
function renderBody(spec: VarSpec, value: VariableValue, meta: OpMeta): string | null {
  const { named, reserved, ifemp } = meta;
  const enc = (s: string) => pctEncode(s, reserved);

  const scalar = typeof value === 'number' || typeof value === 'boolean';
  if (typeof value === 'string' || scalar) {
    let s = String(value);
    if (spec.prefix !== undefined) {
      // Prefix modifier counts Unicode code points (RFC 6570 section 2.4).
      s = Array.from(s).slice(0, spec.prefix).join('');
    }
    if (named) {
      // name '=' is always present; ifemp only distinguishes ?/& ("a=")
      // from ; ("a") for empty values.
      return s === '' ? spec.name + ifemp : spec.name + '=' + enc(s);
    }
    return enc(s);
  }

  const explode = spec.explode;
  // Prefix modifiers are only defined for string values.

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (explode) {
      const parts = value.map((item) => {
        const v = enc(item);
        if (named) return item === '' ? spec.name + ifemp : spec.name + '=' + v;
        return item === '' ? '' : v;
      });
      // Per RFC 6570, empty items leave their separator in place
      // (e.g. ["a",""] with {/list*} expands to "/a/").
      return parts.join(meta.innerSep);
    }
    return (named ? spec.name + '=' : '') + value.map(enc).join(',');
  }

  // Map value.
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  if (explode) {
    const parts = entries.map(([k, v]) => {
      const ek = enc(k);
      if (v === '') {
        // Non-named operators keep only the key ("empty"), named ones keep
        // the trailing '=' ("empty=").
        return named ? ek + '=' + ifemp : ek;
      }
      return ek + '=' + enc(v);
    });
    return parts.join(meta.innerSep);
  }
  const flat: string[] = [];
  for (const [k, v] of entries) {
    flat.push(enc(k));
    flat.push(v === '' ? '' : enc(v));
  }
  return (named ? spec.name + '=' : '') + flat.join(',');
}

/* -------------------------------------------------------------------------- */
/* Partial expansion                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Partially expand a template (or an already partially expanded AST).
 *
 * Known variables are frozen as encoded terms; unknown variables stay in the
 * expression AST retaining their modifiers.  An explicit `undefined` value is
 * distinguished from "not provided": the variable is decided and removed from
 * further consideration.
 */
export function expandPartial(template: string | Template, variables: Variables): Template {
  const ast = typeof template === 'string' ? parse(template) : cloneAst(template);
  for (const node of ast) {
    if (node.type !== 'expression') continue;
    const meta = OPS[node.operator];
    for (let i = 0; i < node.terms.length; i++) {
      const term = node.terms[i];
      if (term.kind !== 'pending') continue;
      if (!Object.prototype.hasOwnProperty.call(variables, term.name)) continue;
      const value = variables[term.name];
      if (value === undefined) {
        node.terms[i] = { kind: 'missing', name: term.name };
        continue;
      }
      const spec = node.specs[i];
      const body = renderBody(spec, value as VariableValue, meta);
      if (body === null) {
        // Empty composite: RFC 6570 treats it like an undefined value (no
        // contribution), so the variable is decided for this expansion.
        node.terms[i] = { kind: 'missing', name: term.name };
        continue;
      }
      node.terms[i] = { kind: 'text', name: term.name, body };
      node.started = true;
    }
  }
  return ast;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

type Entry =
  | { kind: 'text'; body: string }
  /** A maximal run of unresolved (pending) variables. */
  | { kind: 'group'; specs: VarSpec[] };

function toEntries(node: ExpressionNode, complete: boolean): Entry[] {
  const entries: Entry[] = [];
  let group: VarSpec[] = [];
  const flush = () => {
    if (group.length) {
      entries.push({ kind: 'group', specs: group });
      group = [];
    }
  };
  for (let i = 0; i < node.terms.length; i++) {
    const term = node.terms[i];
    if (term.kind === 'pending') {
      group.push(node.specs[i]);
    } else if (term.kind === 'missing') {
      // Decided no-value: contributes nothing and nothing visually. Pending
      // runs can safely merge across it, because a missing variable's name
      // is not carried in the group and thus cannot be resurrected later.
    } else {
      flush();
      entries.push({ kind: 'text', body: term.body });
    }
  }
  flush();
  if (complete) {
    // Final render: unresolved variables are missing and dropped.
    return entries.filter((e) => e.kind === 'text');
  }
  return entries;
}

/** Continuation operator used when a pending group follows known content. */
function continuation(op: Operator): Operator | null {
  switch (op) {
    case '?':
    case '&':
      return '&';
    case ';':
      return ';';
    case '/':
      return '/';
    case '.':
      return '.';
    case '#':
    case '+':
      return op;
    default:
      return null; // simple: groups are bare
  }
}

function specText(s: VarSpec): string {
  return s.name + (s.explode ? '*' : '') + (s.prefix !== undefined ? ':' + s.prefix : '');
}

/**
 * Render an expression node.
 *
 * `complete: true` produces the final RFC 6570 expansion (unknown variables
 * count as missing).  Otherwise unresolved variables are kept as nested
 * template expressions inside the node's text, so the AST is still processable
 * in later rounds.  The operator prefix and separators are derived here from
 * the frozen terms only, so re-expanding a node never duplicates a prefix or
 * separator nor re-encodes earlier values.
 */
function renderExpression(node: ExpressionNode, complete: boolean): string {
  const meta = OPS[node.operator];
  const entries = toEntries(node, complete);
  if (entries.length === 0) return '';
  const bodies = entries.filter((e): e is { kind: 'text'; body: string } => e.kind === 'text');
  if (complete) {
    if (bodies.length === 0) return '';
    return meta.prefix + bodies.map((b) => b.body).join(meta.sep);
  }

  let out = '';
  // START  : nothing emitted yet
  // LEADING: pending group(s) emitted and, when bodies exist, the bridge
  //          separator has already been emitted right after them
  // BODY   : at least one body emitted; separators are derived here
  let state: 'START' | 'LEADING' | 'BODY' = 'START';
  const hasAnyBody = bodies.length > 0;
  for (const entry of entries) {
    if (entry.kind === 'text') {
      if (state === 'START') out += meta.prefix + entry.body;
      else if (state === 'LEADING') out += entry.body; // bridge sep already emitted
      else out += meta.sep + entry.body;
      state = 'BODY';
      continue;
    }
    const specList = entry.specs.map(specText).join(',');
    if (state === 'BODY') {
      // Continuation after emitted content.
      const cont = continuation(node.operator);
      if (cont !== null && cont !== node.operator) {
        out += '{' + cont + specList + '}';
      } else {
        const opInBraces = node.operator === '+' || node.operator === '#' ? node.operator : '';
        out += meta.sep + '{' + opInBraces + specList + '}';
      }
    } else {
      // Leading pending group: owns the first-contribution prefix.
      out += '{' + node.operator + specList + '}';
      // If a body eventually follows, pre-emit the plain bridge separator
      // once (after the last leading group) so the body branch never re-adds
      // the operator prefix.
      if (hasAnyBody && state === 'START') {
        out += meta.sep;
        state = 'LEADING';
      }
    }
  }
  return out;
}

export interface RenderOptions {
  /**
   * When true (default for {@link expand}), all remaining unknown variables
   * are treated as missing and the final RFC 6570 expansion is produced.
   * When false, unresolved variables remain as nested template expressions.
   */
  complete?: boolean;
}

/** Serialize an AST back to a template string. */
export function render(ast: Template, options: RenderOptions = {}): string {
  const complete = options.complete ?? true;
  let out = '';
  for (const node of ast) {
    out += node.type === 'literal' ? encodeLiteral(node.value) : renderExpression(node, complete);
  }
  return out;
}

/**
 * Fully expand a template.  Equivalent to {@link expandPartial} followed by
 * {@link render} in complete mode.
 */
export function expand(template: string, variables: Variables): string {
  return render(expandPartial(template, variables), { complete: true });
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

export function serialize(ast: Template): string {
  return JSON.stringify(ast);
}

/** Load an AST produced by {@link serialize}. */
export function deserialize(json: string): Template {
  const data = JSON.parse(json) as unknown;
  if (!Array.isArray(data)) throw new Error('Invalid serialized template: expected an array');
  for (const node of data as unknown[]) {
    if (!node || typeof node !== 'object') throw new Error('Invalid node');
    const n = node as Record<string, unknown>;
    if (n.type === 'literal') {
      if (typeof n.value !== 'string') throw new Error('Invalid literal node');
    } else if (n.type === 'expression') {
      if (typeof n.operator !== 'string' || !(n.operator in OPS)) {
        throw new Error('Invalid expression operator');
      }
      if (!Array.isArray(n.specs) || !Array.isArray(n.terms)) {
        throw new Error('Invalid expression node');
      }
      if (n.specs.length !== n.terms.length) {
        throw new Error('specs/terms length mismatch');
      }
      if (typeof n.started !== 'boolean') throw new Error('Invalid started state');
    } else {
      throw new Error('Unknown node type');
    }
  }
  return data as Template;
}

function cloneAst(ast: Template): Template {
  return JSON.parse(JSON.stringify(ast)) as Template;
}
