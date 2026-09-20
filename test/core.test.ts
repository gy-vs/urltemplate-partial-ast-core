import { describe, expect, it } from 'vitest';
import {
  deserialize,
  expand,
  expandPartial,
  isComplete,
  parse,
  render,
  serialize,
  type ExpressionNode,
  type Template,
} from '../src/index.js';

/** Helper: run several expansion rounds, returning the final string. */
function rounds(template: string, ...batches: Record<string, unknown>[]): string {
  let ast = parse(template);
  for (const batch of batches) {
    ast = expandPartial(ast, batch as never);
  }
  return render(ast);
}

describe('one-shot expansion', () => {
  it('expands a simple value', () => {
    expect(expand('/{id}', { id: 'a b' })).toBe('/a%20b');
  });

  it('supports the query continuation operator &', () => {
    expect(expand('{?a,b}', { a: '1', b: '2' })).toBe('?a=1&b=2');
    expect(expand('/search{?q,page}', { q: 'a b', page: '3' })).toBe(
      '/search?q=a%20b&page=3',
    );
  });

  it('supports path segments', () => {
    expect(expand('/{a}{/b,c}', { a: 'x', b: 'y', c: 'z' })).toBe('/x/y/z');
    expect(expand('{/path}', { path: 'a/b' })).toBe('/a%2Fb');
  });

  it('supports reserved expansion and fragments without re-encoding', () => {
    expect(expand('{+url}', { url: 'http://example.com/a b' })).toBe(
      'http://example.com/a%20b',
    );
    expect(expand('{#sec}', { sec: 'part 1' })).toBe('#part%201');
  });

  it('supports prefix modifiers', () => {
    expect(expand('{a:3}', { a: 'hello' })).toBe('hel');
    expect(expand('{?a:2}', { a: 'hello' })).toBe('?a=he');
  });

  it('treats an explicitly undefined variable as resolved-and-absent', () => {
    expect(expand('a={a}', { a: undefined })).toBe('a=');
    expect(expand('{?a,b}', { a: undefined, b: '2' })).toBe('?b=2');
  });
});

describe('partial expansion keeps an AST', () => {
  it('leaves unknown variables as expression nodes, not literal text', () => {
    const ast = expandPartial('{?a,b}', { a: '1' });
    expect(isComplete(ast)).toBe(false);
    expect(ast).toHaveLength(2);
    expect(ast[0]).toEqual({ type: 'literal', value: '?a=1' });
    const residual = ast[1] as ExpressionNode;
    expect(residual.type).toBe('expression');
    expect(residual.operator).toBe('?');
    expect(residual.varspecs).toEqual([{ name: 'b', modifier: null }]);
    expect(residual.started).toBe(true);
  });

  it('does not emit a second question mark for a continued ? expression', () => {
    expect(rounds('{?a,b}', { a: '1' }, { b: '2' })).toBe('?a=1&b=2');
    expect(rounds('/x{?a,b,c}', { a: '1' }, { b: '2', c: '3' })).toBe(
      '/x?a=1&b=2&c=3',
    );
  });

  it('continues & expressions with & and never a leading ?', () => {
    expect(rounds('?fixed=yes{&a,b}', { a: '1' }, { b: '2' })).toBe(
      '?fixed=yes&a=1&b=2',
    );
  });

  it('continues fragments with commas instead of a second hash', () => {
    expect(rounds('{#a,b}', { a: '1' }, { b: '2' })).toBe('#1,2');
    expect(rounds('{+a,b,c}', { a: '1' }, { b: '2' }, { c: '3' })).toBe(
      '1,2,3',
    );
  });

  it('continues path segments without an extra slash-less prefix', () => {
    expect(rounds('{/a,b}', { a: 'x' }, { b: 'y' })).toBe('/x/y');
    expect(rounds('{.a,b}', { a: 'x' }, { b: 'y' })).toBe('.x.y');
  });

  it('continues semicolon style params', () => {
    expect(rounds('{;a,b}', { a: 'x' }, { b: 'y' })).toBe(';a=x;b=y');
  });

  it('handles multiple variables in one expression across rounds', () => {
    // Each varspec is supplied exactly when its turn in the expression comes.
    expect(rounds('{a,b,c,d}', { a: '1' }, { b: '2' }, { c: '3' }, { d: '4' })).toBe(
      '1,2,3,4',
    );
    // Known vars ahead of the first missing one are all consumed at once.
    expect(rounds('{a,b,c}', { a: '1', b: '2' }, { c: '3' })).toBe('1,2,3');
    expect(expand('{a,b,c,d}', { a: '1', b: '2', c: '3', d: '4' })).toBe(
      '1,2,3,4',
    );
  });

  it('halts at the first not-provided variable and keeps later specs too', () => {
    const ast = expandPartial('{a,b,c}', { a: '1', c: '3' });
    // b is missing -> b,c remain (c can't overtake b: output order is fixed).
    const residual = ast[1] as ExpressionNode;
    expect(residual.varspecs.map((s) => s.name)).toEqual(['b', 'c']);
  });

  it('handles repeated variables in one expression', () => {
    // Repeated specs are independent per RFC 6570.
    const direct = expand('{a,a}', { a: 'x' });
    expect(direct).toBe('x,x');
    // Supplying the repeated name in one round expands both copies.
    expect(rounds('{a,a}', { a: 'x' })).toBe(direct);
    // First round: both copies emitted because they share the same name.
    const ast = expandPartial('{a,a}', { a: 'x' });
    expect(isComplete(ast)).toBe(true);
  });

  it('handles repeated variable names with different modifiers', () => {
    const direct = expand('{a:1,a}', { a: 'abc' });
    expect(direct).toBe('a,abc');
    expect(rounds('{a:1,a}', { a: 'abc' })).toBe(direct);
  });

  it('handles empty known values', () => {
    expect(rounds('{?a,b}', { a: '' }, { b: '2' })).toBe('?a=&b=2');
    expect(rounds('{#a,b}', { a: '' }, { b: 'z' })).toBe('#,z');
    // ';name' style omits the '=' for empty values (RFC 6570 §3.2.8).
    expect(rounds('{;a,b}', { a: '' }, { b: 'z' })).toBe(';a;b=z');
    expect(expand('{;a,b}', { a: '', b: 'z' })).toBe(';a;b=z');
  });

  it('treats empty string as emitted even for prefix-less operators', () => {
    // {+a,b}: a is empty but starts the expression; b must use a comma.
    expect(rounds('{+a,b}', { a: '' }, { b: 'x/y' })).toBe(',x/y');
    expect(expand('{+a,b}', { a: '', b: 'x/y' })).toBe(',x/y');
  });

  it('continues explode lists', () => {
    const vars = { a: ['1', '2'], b: ['3', '4'] };
    const direct = expand('{a*,b*}', vars);
    expect(direct).toBe('1,2,3,4');
    expect(rounds('{a*,b*}', { a: ['1', '2'] }, { b: ['3', '4'] })).toBe(
      direct,
    );
    expect(
      rounds('/x{?a*,b*}', { a: ['1', '2'] }, { b: ['3', '4'] }),
    ).toBe('/x?a=1&a=2&b=3&b=4');
    expect(expand('/x{?a*,b*}', vars)).toBe('/x?a=1&a=2&b=3&b=4');
  });

  it('continues explode maps', () => {
    const vars = { a: { k: 'v', n: '7' }, b: { x: 'y' } };
    const direct = expand('{?a*,b*}', vars);
    expect(direct).toBe('?k=v&n=7&x=y');
    expect(rounds('{?a*,b*}', { a: { k: 'v', n: '7' } }, { b: { x: 'y' } })).toBe(
      direct,
    );
    // Fragment-style explode maps use comma separators.
    const direct2 = expand('{#a*,b*}', vars);
    expect(direct2).toBe('#k=v,n=7,x=y');
    expect(rounds('{#a*,b*}', { a: vars.a }, { b: vars.b })).toBe(direct2);
  });

  it('continues non-explode maps', () => {
    const vars = { a: { k: 'v' }, b: { x: 'y' } };
    const direct = expand('{a,b}', vars);
    expect(direct).toBe('k,v,x,y');
    expect(rounds('{a,b}', { a: { k: 'v' } }, { b: { x: 'y' } })).toBe(direct);
  });

  it('supports many rounds of partial expansion', () => {
    expect(
      rounds(
        '/users/{id}{?q,page,sort}',
        { id: '42' },
        { q: 'a b' },
        { page: '2' },
        { sort: 'name' },
      ),
    ).toBe('/users/42?q=a%20b&page=2&sort=name');
  });

  it('keeps prefix and explode modifiers on the residual node', () => {
    const ast = expandPartial('{a:5,b*}', {});
    const residual = ast[0] as ExpressionNode;
    expect(residual.varspecs).toEqual([
      { name: 'a', modifier: 5 },
      { name: 'b', modifier: true },
    ]);
    expect(rounds('{a:5,b*}', {}, { a: 'hello', b: ['x', 'y'] })).toBe(
      'hello,x,y',
    );
  });

  it('distinguishes explicit undefined from never-provided variables', () => {
    // a: explicitly undefined -> resolved, dropped; b: missing -> remains.
    const ast = expandPartial('{?a,b,c}', { a: undefined, c: '3' });
    const residual = ast.find(
      (n): n is ExpressionNode => n.type === 'expression',
    );
    expect(residual.varspecs.map((s) => s.name)).toEqual(['b', 'c']);
    expect(residual.started).toBe(false);
    // Providing b later unlocks c as well and equals one-shot semantics.
    const vars = { a: undefined, b: '2', c: '3' };
    expect(rounds('{?a,b,c}', { a: undefined }, { b: '2', c: '3' })).toBe(
      expand('{?a,b,c}', vars),
    );
  });

  it('does not double-encode values emitted in earlier rounds', () => {
    const tricky = 'a+b/c?d=e&f g%';
    const direct = expand('{+a}{b}', { a: tricky, b: tricky });
    expect(direct).toContain('a+b/c?d=e&f%20g%25');
    expect(direct).toContain('a%2Bb%2Fc%3Fd%3De%26f%20g%25');
    const partial = rounds('{+a}{b}', { a: tricky }, { b: tricky });
    expect(partial).toBe(direct);
  });
});

describe('serialization', () => {
  it('can be serialized, loaded, and expanded further', () => {
    let ast = expandPartial('{?a,b}', { a: '1' });
    const json = JSON.stringify(serialize(ast));
    const loaded = deserialize(JSON.parse(json));
    const again = expandPartial(loaded, { b: '2' });
    expect(render(again)).toBe('?a=1&b=2');
  });

  it('survives serialization through multiple rounds', () => {
    const vars = { a: '1', b: '2', c: '3' };
    let ast: Template = parse('/x{?a,b,c}');
    ast = expandPartial(ast, { a: vars.a });
    ast = deserialize(JSON.parse(JSON.stringify(serialize(ast)))) as Template;
    ast = expandPartial(ast, { b: vars.b });
    ast = deserialize(JSON.parse(JSON.stringify(serialize(ast)))) as Template;
    ast = expandPartial(ast, { c: vars.c });
    expect(render(ast)).toBe(expand('/x{?a,b,c}', vars));
  });

  it('rejects malformed serialized data', () => {
    expect(() => deserialize(null)).toThrow();
    expect(() => deserialize({ version: 99, nodes: [] })).toThrow();
    expect(() =>
      deserialize({ version: 1, nodes: [{ type: 'bogus' }] }),
    ).toThrow();
    expect(() =>
      deserialize({
        version: 1,
        nodes: [
          { type: 'expression', operator: '?', started: 'no', varspecs: [] },
        ],
      }),
    ).toThrow();
  });
});

describe('partial expansion equals one-shot expansion', () => {
  // Every split of the variable-arrival schedule (in varspec order) must
  // produce exactly the direct one-shot result.
  const cases: { template: string; variables: Record<string, unknown> }[] = [
    { template: '{?a,b,c}', variables: { a: '1', b: '2', c: '3' } },
    { template: '/search{?q,page}', variables: { q: 'a b', page: '3' } },
    { template: '?fixed=yes{&a,b}', variables: { a: '1', b: '2' } },
    { template: '{/a,b,c}', variables: { a: 'x', b: 'y', c: 'z' } },
    { template: '{#a,b}', variables: { a: 'p 1', b: 'p2' } },
    { template: '{;a,b}', variables: { a: 'x', b: '' } },
    { template: '{a*,b*}', variables: { a: ['1', '2'], b: ['3', '4'] } },
    {
      template: '{?a*,b*}',
      variables: { a: { k: 'v', n: '7' }, b: { x: 'y' } },
    },
    { template: '{a,b}', variables: { a: { k: 'v' }, b: { x: 'y' } } },
    { template: '{a:3,b:2}', variables: { a: 'hello', b: 'world' } },
    { template: '/u/{id}{?q,sort}', variables: { id: '4 2', q: 'x y', sort: 'n' } },
  ];

  for (const { template, variables } of cases) {
    it(template, () => {
      const direct = expand(template, variables as never);
      // Unique variable names in the order they appear in the template.
      const order = [
        ...new Set(
          parse(template).flatMap((node) =>
            node.type === 'expression' ? node.varspecs.map((s) => s.name) : [],
          ),
        ),
      ];
      for (let split = 0; split <= order.length; split++) {
        const pick = (keys: string[]) =>
          Object.fromEntries(keys.map((key) => [key, (variables as Record<string, unknown>)[key]]));
        const result = rounds(template, pick(order.slice(0, split)), pick(order.slice(split)));
        expect(result).toBe(direct);
      }
    });
  }
});

describe('render and parse errors', () => {
  it('render throws on unresolved variables', () => {
    expect(() => render(expandPartial('{a}', {}))).toThrow(/a/);
  });

  it('parse rejects malformed templates', () => {
    expect(() => parse('{a')).toThrow();
    expect(() => parse('a}')).toThrow();
    expect(() => parse('{}')).toThrow();
  });
});
