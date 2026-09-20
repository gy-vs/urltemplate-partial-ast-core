/**
 * URI template (RFC 6570) engine with partial expansion.
 *
 * Unknown variables are kept as expression nodes in the AST instead of
 * degrading into concatenated strings, so a template can be expanded over
 * several rounds and the final result is identical to one-shot expansion.
 */

/** Variable values as defined by RFC 6570. `undefined` means explicitly undefined. */
export type VariableValue = string | string[] | Record<string, string> | undefined;
export type Variables = Record<string, VariableValue>;

export type Operator = '' | '+' | '#' | '.' | '/' | ';' | '?' | '&';

/** A single `varname` plus optional explode (`*`) / prefix (`:n`) modifier. */
export interface VarSpec {
  name: string;
  /** `true` for `var*`, otherwise a number for `var:n`, otherwise `null`. */
  modifier: number | boolean | null;
}

/** Literal text already encoded; it is never encoded again on later rounds. */
export interface LiteralNode {
  type: 'literal';
  value: string;
}

/**
 * An unresolved expression, possibly partially expanded.
 *
 * `started` records whether the expression already emitted anything: it
 * tracks consumption of the operator prefix (`?`, `#`, `.` ...) and of the
 * first separator. A continued expression therefore emits `&`/`,`/`=` style
 * separators instead of a second `?`/`#`/`,` prefix.
 */
export interface ExpressionNode {
  type: 'expression';
  operator: Operator;
  varspecs: VarSpec[];
  /** Whether any value (including an empty one) has already been emitted. */
  started: boolean;
}

export type TemplateNode = LiteralNode | ExpressionNode;
export type Template = TemplateNode[];

export const TEMPLATE_VERSION = 1;

interface OperatorDef {
  first: string;
  sep: string;
  named: boolean;
  ifEmpty: string;
  allowReserved: boolean;
}

const OPERATORS: Record<Operator, OperatorDef> = {
  '':  { first: '',  sep: ',', named: false, ifEmpty: '',  allowReserved: false },
  '+': { first: '',  sep: ',', named: false, ifEmpty: '',  allowReserved: true  },
  '#': { first: '#', sep: ',', named: false, ifEmpty: '',  allowReserved: true  },
  '.': { first: '.', sep: '.', named: false, ifEmpty: '.', allowReserved: false },
  '/': { first: '/', sep: '/', named: false, ifEmpty: '/', allowReserved: false },
  ';': { first: ';', sep: ';', named: true,  ifEmpty: '',  allowReserved: false },
  '?': { first: '?', sep: '&', named: true,  ifEmpty: '=', allowReserved: false },
  '&': { first: '&', sep: '&', named: true,  ifEmpty: '=', allowReserved: false },
};

const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
);
const RESERVED = new Set(":/?#[]@!$&'()*+,;=");
const TEXT_ENCODER = new TextEncoder();

/** RFC 6570 percent-encoding of one literal/value string. */
function encodeValue(text: string, allowReserved: boolean): string {
  const bytes = TEXT_ENCODER.encode(text);
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (UNRESERVED.has(ch) || (allowReserved && RESERVED.has(ch))) {
      out += ch;
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

const EXPRESSION_RE = /\{([+#./;?&]?)([^{}]*)\}/y;
const VARSPEC_RE = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\*|:\d{1,4})?$/;

/** Parse a template string into an AST. */
export function parse(template: string): Template {
  const nodes: Template = [];
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' || ch === '}') {
      if (ch === '}') throw new Error(`unexpected '}' at position ${i}`);
      EXPRESSION_RE.lastIndex = i;
      const match = EXPRESSION_RE.exec(template);
      if (!match) {
        throw new Error(`malformed expression starting at position ${i}`);
      }
      const operator = match[1] as Operator;
      const specText = match[2];
      if (specText.length === 0) {
        throw new Error(`empty expression at position ${i}`);
      }
      const varspecs: VarSpec[] = specText.split(',').map((part) => {
        const specMatch = VARSPEC_RE.exec(part);
        if (!specMatch) {
          throw new Error(`invalid varspec '${part}' in expression at position ${i}`);
        }
        let modifier: VarSpec['modifier'] = null;
        if (specMatch[2] === '*') modifier = true;
        else if (specMatch[2] !== undefined) modifier = Number(specMatch[2].slice(1));
        return { name: specMatch[1], modifier };
      });
      nodes.push({ type: 'expression', operator, varspecs, started: false });
      i += match[0].length;
    } else {
      let next = template.indexOf('{', i);
      const close = template.indexOf('}', i);
      if (close !== -1 && (next === -1 || close < next)) {
        throw new Error(`unexpected '}' at position ${close}`);
      }
      if (next === -1) next = template.length;
      nodes.push({ type: 'literal', value: template.slice(i, next) });
      i = next;
    }
  }
  return nodes;
}

/** Look up a variable: missing vs. explicitly undefined are distinguished. */
function lookup(
  variables: Variables,
  name: string,
): { present: false } | { present: true; value: Exclude<VariableValue, undefined> } | undefined {
  if (!Object.prototype.hasOwnProperty.call(variables, name)) return { present: false };
  const value = variables[name];
  // Explicitly undefined: present, but contributes nothing.
  if (value === undefined) return undefined;
  // Empty composite values contribute nothing (RFC 6570 §3.2.1).
  if ((Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0)) {
    return undefined;
  }
  return { present: true, value };
}

function isPlainObject(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join('');
}

interface ExpressionResult {
  output: string;
  /** Whether the expression has emitted any value (including an empty one). */
  started: boolean;
  /** Remaining specs when expansion halted on a not-yet-provided variable. */
  remaining: VarSpec[] | null;
}

/** Expand an expression node as far as the given variables allow. */
function expandExpression(node: ExpressionNode, variables: Variables): ExpressionResult {
  const def = OPERATORS[node.operator];
  let out = '';
  let started = node.started;

  const emit = (piece: string) => {
    if (!started) {
      out += def.first;
      started = true;
    } else {
      out += def.sep;
    }
    out += piece;
  };

  for (let index = 0; index < node.varspecs.length; index++) {
    const spec = node.varspecs[index];
    const found = lookup(variables, spec.name);

    if (found === undefined) {
      // Explicitly undefined (or empty composite): resolved, emits nothing.
      continue;
    }
    if (!found.present) {
      // Never provided: halt. Everything from this spec on stays in the AST.
      return { output: out, started, remaining: node.varspecs.slice(index) };
    }

    const value = found.value;

    if (typeof value === 'string') {
      let text = value;
      if (typeof spec.modifier === 'number') text = truncate(text, spec.modifier);
      const encoded = encodeValue(text, def.allowReserved);
      if (def.named) {
        emit(spec.name + (text === '' ? def.ifEmpty : '=' + encoded));
      } else {
        emit(encoded);
      }
    } else if (Array.isArray(value)) {
      const parts = value.map((item) => encodeValue(item, def.allowReserved && spec.modifier === true));
      if (spec.modifier === true) {
        for (const item of parts) {
          if (def.named) emit(spec.name + '=' + item);
          else emit(item);
        }
      } else {
        if (def.named) emit(spec.name + '=' + parts.join(','));
        else emit(parts.join(','));
      }
    } else {
      const entries = Object.entries(value);
      const enc = (s: string) => encodeValue(s, def.allowReserved && spec.modifier === true);
      if (spec.modifier === true) {
        for (const [key, val] of entries) {
          // Explode pairs always carry a literal '=', even for empty values.
          emit(enc(key) + '=' + enc(val));
        }
      } else {
        const flat = entries.flatMap(([key, val]) => [enc(key), enc(val)]).join(',');
        if (def.named) emit(spec.name + '=' + flat);
        else emit(flat);
      }
    }
  }

  return { output: out, started, remaining: null };
}

function pushLiteral(nodes: Template, value: string): void {
  if (value === '') return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'literal') last.value += value;
  else nodes.push({ type: 'literal', value });
}

/**
 * Expand an AST with the given variables.
 *
 * Known varspecs become encoded literal text. Specs that depend on variables
 * that have never been provided remain as expression nodes (with prefix /
 * separator consumption state recorded in `started`). Explicitly `undefined`
 * variables are resolved away.
 */
export function expandPartial(ast: Template | string, variables: Variables): Template {
  const template = typeof ast === 'string' ? parse(ast) : ast;
  const result: Template = [];
  for (const node of template) {
    if (node.type === 'literal') {
      pushLiteral(result, node.value);
      continue;
    }
    const expanded = expandExpression(node, variables);
    pushLiteral(result, expanded.output);
    if (expanded.remaining !== null) {
      result.push({
        type: 'expression',
        operator: node.operator,
        varspecs: expanded.remaining,
        started: expanded.started,
      });
    }
  }
  return result;
}

/** True when no unresolved expressions remain. */
export function isComplete(ast: Template): boolean {
  return ast.every((node) => node.type === 'literal');
}

/** Render a fully resolved AST to its string form. */
export function render(ast: Template): string {
  const unresolved = ast.find((node) => node.type === 'expression') as ExpressionNode | undefined;
  if (unresolved) {
    throw new Error(`cannot render template: variable '${unresolved.varspecs[0].name}' is not provided`);
  }
  return ast.map((node) => (node.type === 'literal' ? node.value : '')).join('');
}

/** One-shot expansion; throws if any variable is missing. */
export function expand(template: string, variables: Variables): string {
  return render(expandPartial(template, variables));
}

/** Serialize an AST to a plain JSON-compatible value. */
export function serialize(ast: Template): unknown {
  return { version: TEMPLATE_VERSION, nodes: ast };
}

/** Validate and load an AST previously produced by {@link serialize}. */
export function deserialize(data: unknown): Template {
  if (typeof data !== 'object' || data === null) throw new Error('invalid serialized template: expected object');
  const root = data as { version?: unknown; nodes?: unknown };
  if (root.version !== TEMPLATE_VERSION) {
    throw new Error(`unsupported template version: ${String(root.version)}`);
  }
  if (!Array.isArray(root.nodes)) throw new Error('invalid serialized template: nodes must be an array');
  return root.nodes.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`invalid node at index ${i}`);
    }
    const node = raw as Record<string, unknown>;
    if (node.type === 'literal') {
      if (typeof node.value !== 'string') throw new Error(`invalid literal at index ${i}`);
      return { type: 'literal', value: node.value };
    }
    if (node.type === 'expression') {
      if (typeof node.operator !== 'string' || !(node.operator in OPERATORS)) {
        throw new Error(`invalid operator at index ${i}`);
      }
      if (typeof node.started !== 'boolean') throw new Error(`invalid expression state at index ${i}`);
      if (!Array.isArray(node.varspecs)) throw new Error(`invalid varspecs at index ${i}`);
      const varspecs: VarSpec[] = node.varspecs.map((spec: unknown, j: number) => {
        if (typeof spec !== 'object' || spec === null) throw new Error(`invalid varspec at ${i}.${j}`);
        const v = spec as Record<string, unknown>;
        if (typeof v.name !== 'string') throw new Error(`invalid varspec name at ${i}.${j}`);
        if (!(v.modifier === null || v.modifier === true || typeof v.modifier === 'number')) {
          throw new Error(`invalid varspec modifier at ${i}.${j}`);
        }
        return { name: v.name, modifier: v.modifier } as VarSpec;
      });
      return {
        type: 'expression',
        operator: node.operator as Operator,
        varspecs,
        started: node.started,
      };
    }
    throw new Error(`unknown node type at index ${i}`);
  });
}
