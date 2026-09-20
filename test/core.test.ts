import { describe, expect, it } from 'vitest';
import {
  deserialize,
  expand,
  expandPartial,
  parse,
  render,
  serialize,
  type Template,
  type Variables,
} from '../src/index.js';

/**
 * Reference property: completing a partially expanded AST (possibly over
 * several rounds, possibly through serialize/deserialize) must always equal
 * expanding the original template once with all the accumulated variables.
 */
function rounds(template: string, rounds: Variables[]): {
  partials: string[];
  final: string;
  direct: string;
} {
  // Expansion freezes each variable the first time it is provided (already
  // emitted output never changes), so the equivalent one-shot expansion uses
  // first-round-wins merging.
  const all: Variables = {};
  for (const r of rounds) {
    for (const [k, v] of Object.entries(r)) {
      if (!Object.prototype.hasOwnProperty.call(all, k)) all[k] = v;
    }
  }
  const partials: string[] = [];
  let ast: Template = parse(template);
  for (const vars of rounds) {
    ast = expandPartial(ast, vars);
    partials.push(render(ast, { complete: false }));
  }
  return { partials, final: render(ast), direct: expand(template, all) };
}

describe('backward compatible one-shot expansion', () => {
  it('expands a value', () => {
    expect(expand('/{id}', { id: 'a b' })).toBe('/a%20b');
  });

  it('query and continuation operators', () => {
    expect(expand('{?a,b}', { a: '1', b: '2' })).toBe('?a=1&b=2');
    expect(expand('{&a,b}', { a: '1', b: '2' })).toBe('&a=1&b=2');
    expect(expand('{?a,b}', { b: '2' })).toBe('?b=2');
    expect(expand('{?a,b}', {})).toBe('');
  });

  it('fragment, path, label and matrix operators', () => {
    expect(expand('{#a,b}', { a: 'x', b: 'y' })).toBe('#x,y');
    expect(expand('{/a,b}', { a: 'x', b: 'y' })).toBe('/x/y');
    expect(expand('{.a,b}', { a: 'x', b: 'y' })).toBe('.x.y');
    expect(expand('{;a,b}', { a: 'x', b: 'y' })).toBe(';a=x;b=y');
  });

  it('reserved expansion leaves reserved chars open', () => {
    expect(expand('{+a}', { a: 'a/b?c' })).toBe('a/b?c');
    expect(expand('{a}', { a: 'a/b' })).toBe('a%2Fb');
  });
});

describe('partial expansion retains an expression AST', () => {
  it('unknown variables remain as expression text, not glued strings', () => {
    const ast = expandPartial('{?a,b}', { b: '2' });
    expect(ast).toHaveLength(1);
    expect(ast[0].type).toBe('expression');
    const node = ast[0] as Extract<Template[number], { type: 'expression' }>;
    expect(node.operator).toBe('?');
    expect(node.specs).toEqual([
      { name: 'a', explode: false },
      { name: 'b', explode: false },
    ]);
    expect(node.terms.map((t) => t.kind)).toEqual(['pending', 'text']);
    // Prefix already consumed by the known variable.
    expect(node.started).toBe(true);
  });

  it('query continuation: completing later adds no duplicated ? or &', () => {
    const r = rounds('{?a,b}', [{ b: '2' }, { a: '1' }]);
    expect(r.partials[0]).toBe('{?a}&b=2');
    expect(r.final).toBe(r.direct);
    expect(r.final).toBe('?a=1&b=2');
    expect(r.final).not.toMatch(/\?.*\?/);
  });

  it('fragment continuation: completing later adds no duplicated # or comma', () => {
    const r = rounds('{#a,b}', [{ b: '2' }, { a: '1' }]);
    expect(r.partials[0]).toBe('{#a},2');
    expect(r.final).toBe('#1,2');
    expect(r.final).toBe(r.direct);
  });

  it('path segments do not duplicate slashes', () => {
    const r = rounds('/d/{/a,b}/e', [{ b: 'y' }, { a: 'x' }]);
    expect(r.partials[0]).toBe('/d/{/a}/y/e');
    expect(r.final).toBe('/d//x/y/e');
    expect(r.final).toBe(r.direct);
  });

  it('label and matrix continuations', () => {
    expect(rounds('{.a,b}', [{ a: 'x' }, { b: 'y' }]).final).toBe('.x.y');
    const semi = rounds('{;a,b}', [{ b: 'y' }, { a: 'x' }]);
    expect(semi.partials[0]).toBe('{;a};b=y');
    expect(semi.final).toBe(';a=x;b=y');
    expect(semi.final).toBe(semi.direct);
  });

  it('multiple variables in one expression expand from both ends', () => {
    const r = rounds('{a,b,c,d}', [{ b: '2' }, { d: '4' }, { a: '1' }, { c: '3' }]);
    expect(r.partials[0]).toBe('{a},2,{c,d}');
    expect(r.partials[1]).toBe('{a},2,{c},4');
    expect(r.partials[2]).toBe('1,2,{c},4');
    expect(r.final).toBe('1,2,3,4');
    expect(r.final).toBe(r.direct);
  });

  it('repeated variables resolve consistently across rounds', () => {
    const r = rounds('{a,a,b}', [{ a: 'x' }, { b: 'y' }]);
    expect(r.final).toBe('x,x,y');
    expect(r.final).toBe(r.direct);
    // First round value is frozen; later values do not override it.
    const again = rounds('{a,a}', [{ a: 'x' }, { a: 'z' }]);
    expect(again.final).toBe('x,x');
  });

  it('empty known string values count as contributed', () => {
    expect(expand('{?a,b}', { a: '', b: '2' })).toBe('?a=&b=2');
    const r = rounds('{?a,b}', [{ a: '' }, { b: '2' }]);
    expect(r.partials[0]).toBe('?a={&b}');
    expect(r.final).toBe('?a=&b=2');
    expect(r.final).toBe(r.direct);

    const semi = rounds('{;a,b}', [{ a: '' }, { b: '2' }]);
    expect(semi.final).toBe(';a;b=2');
    expect(semi.final).toBe(semi.direct);

    expect(rounds('{a,b}', [{ a: '' }, { b: 'x' }]).final).toBe(',x');
  });

  it('explicit undefined is distinct from not provided', () => {
    const ast = expandPartial('{?a,b}', { a: undefined, b: '2' });
    const node = ast[0] as Extract<Template[number], { type: 'expression' }>;
    expect(node.terms[0]).toEqual({ kind: 'missing', name: 'a' });
    expect(node.terms[1].kind).toBe('text');

    // An explicit undefined stays decided: providing a value later must not
    // resurrect it (equivalent to the one-shot undefined semantics).
    const r = rounds('{?a,b}', [{ a: undefined }, { a: 'late', b: '2' }]);
    expect(r.final).toBe('?b=2');
    expect(r.final).toBe(expand('{?a,b}', { a: undefined, b: '2' }));

    // ...whereas a merely unprovided variable still resolves later.
    const r2 = rounds('{?a,b}', [{}, { a: '1', b: '2' }]);
    expect(r2.final).toBe('?a=1&b=2');
  });

  it('prefix modifier is retained on pending nodes and applied at the end', () => {
    const ast = expandPartial('{a:3,b}', { b: 'x' });
    const node = ast[0] as Extract<Template[number], { type: 'expression' }>;
    expect(node.terms[0]).toEqual({ kind: 'pending', name: 'a', explode: false, prefix: 3 });

    const r = rounds('{a:3,b}', [{ b: 'long' }, { a: 'abcdef' }]);
    expect(r.final).toBe('abc,long');
    expect(r.final).toBe(r.direct);
    expect(r.final).toBe(expand('{a:3,b}', { a: 'abcdef', b: 'long' }));
  });

  it('explode modifier is retained on pending nodes', () => {
    const ast = expandPartial('{a*,b}', { b: 'x' });
    const node = ast[0] as Extract<Template[number], { type: 'expression' }>;
    expect(node.terms[0]).toEqual({ kind: 'pending', name: 'a', explode: true });

    const list = rounds('{a*,b}', [{ b: 'x' }, { a: ['1', '2'] }]);
    expect(list.final).toBe('1,2,x');
    expect(list.final).toBe(list.direct);
  });

  it('exploded maps across rounds for every operator', () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['{m*}', { a: '1', b: '2' }, 'a=1,b=2'],
      ['{+m*}', { a: '1', b: '2' }, 'a=1,b=2'],
      ['{#m*}', { a: '1', b: '2' }, '#a=1,b=2'],
      ['{.m*}', { a: '1', b: '2' }, '.a=1.b=2'],
      ['{/m*}', { a: '1', b: '2' }, '/a=1/b=2'],
      ['{;m*}', { a: '1', b: '2' }, ';a=1;b=2'],
      ['{?m*}', { a: '1', b: '2' }, '?a=1&b=2'],
      ['{&m*}', { a: '1', b: '2' }, '&a=1&b=2'],
    ];
    for (const [template, value, expected] of cases) {
      expect(expand(template, { m: value })).toBe(expected);
      const r = rounds(template, [{ other: 'z' }, { m: value }]);
      expect(r.final).toBe(expected);
      expect(r.final).toBe(r.direct);
    }
  });

  it('exploded lists and separators inside frozen terms are not re-encoded', () => {
    const r = rounds('{?a,b*}', [
      { b: ['x y', 'z'] },
      { a: '1' },
    ]);
    expect(r.partials[0]).toBe('{?a}&b=x%20y&b=z');
    expect(r.final).toBe('?a=1&b=x%20y&b=z');
    expect(r.final).toBe(r.direct);
    // Frozen percent encoding must not be encoded a second time.
    expect(r.final).not.toContain('%25');
  });

  it('multi-round partial expansion with several expressions', () => {
    const template = 'https://host/{user}{?q,page,size}#frag';
    const r = rounds(template, [{ page: '2' }, { user: 'bob' }, { q: 'a b' }, { size: '10' }]);
    expect(r.partials[0]).toBe('https://host/{user}{?q}&page=2{&size}#frag');
    expect(r.partials[1]).toBe('https://host/bob{?q}&page=2{&size}#frag');
    expect(r.partials[2]).toBe('https://host/bob?q=a%20b&page=2{&size}#frag');
    expect(r.final).toBe('https://host/bob?q=a%20b&page=2&size=10#frag');
    expect(r.final).toBe(r.direct);
  });

  it('partial view is stable when re-rendered with no new variables', () => {
    let ast = expandPartial('{?a,b}', { b: '2' });
    const first = render(ast, { complete: false });
    ast = expandPartial(ast, { unrelated: 'x' });
    const second = render(ast, { complete: false });
    expect(second).toBe(first);
    expect(second).toBe('{?a}&b=2');
  });

  it('empty composites contribute nothing but are decided', () => {
    expect(expand('x{?a}y', { a: [] })).toBe('xy');
    expect(expand('x{?a}y', { a: {} })).toBe('xy');
    const r = rounds('{?a,b}', [{ a: [] as string[] }, { a: 'late', b: '2' }]);
    expect(r.final).toBe('?b=2');
    expect(r.direct).toBe('?b=2');
    expect(r.final).toBe(r.direct);
  });
});

describe('serialization round-trip', () => {
  it('AST can be serialized and loaded, then expanded in more rounds', () => {
    let ast = expandPartial('{?a,b}', { b: '2' });
    const json = serialize(ast);
    expect(() => JSON.parse(json)).not.toThrow();

    ast = deserialize(json);
    ast = expandPartial(ast, { a: '1' });
    expect(render(ast)).toBe('?a=1&b=2');
  });

  it('multi-round completion through JSON equals direct expansion', () => {
    const template = '{/path*}{?q,page}{#h}';
    let ast = expandPartial(template, { page: '9' });
    ast = deserialize(serialize(ast));
    ast = expandPartial(ast, { q: 'hi' });
    ast = deserialize(serialize(ast));
    ast = expandPartial(ast, { path: ['a', 'b'], h: 'top' });
    expect(render(ast)).toBe(expand(template, { path: ['a', 'b'], q: 'hi', page: '9', h: 'top' }));
    expect(render(ast)).toBe('/a/b?q=hi&page=9#top');
  });

  it('invalid serialized AST is rejected', () => {
    expect(() => deserialize('"nope"')).toThrow();
    expect(() => deserialize(JSON.stringify([{ type: 'expression', operator: '~' }]))).toThrow();
  });
});

describe('fuzz: partial rounds always equal one-shot expansion', () => {
  const templates = [
    '{a}',
    '{a,b,c}',
    '{+a,b}',
    '{#a,b,c}',
    '{.a,b}',
    '{/a,b,c}',
    '{;a,b}',
    '{?a,b,c}',
    '{&a,b}',
    '{a:2,b:4}',
    '{a*,b}',
    '{?a*,b*}',
    '/root/{id}{?q,limit}{#tag}',
  ];

  const pool: Array<string | string[] | Record<string, string> | undefined> = [
    'simple',
    'a b/c?d',
    '',
    ['x', 'y z'],
    ['only'],
    [],
    { k1: 'v1', 'k 2': 'v/2' },
    {},
    undefined,
  ];

  const varNames = ['a', 'b', 'c', 'id', 'q', 'limit', 'tag'];

  function pseudoRandom(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  it('every split into 1-3 rounds, with/without explicit undefined, matches', () => {
    const rand = pseudoRandom(42);
    for (const template of templates) {
      for (let trial = 0; trial < 60; trial++) {
        // Build the full variable set for this trial; decide which variables
        // are present at all and which are explicit undefined.
        const full: Variables = {};
        for (const name of varNames) {
          if (rand() < 0.75) {
            const v = pool[Math.floor(rand() * pool.length)];
            // Presence of the key matters: undefined means explicit undefined.
            full[name] = v;
          }
        }
        const names = Object.keys(full);
        // Shuffle into rounds.
        const order = names.slice().sort(() => rand() - 0.5);
        const bucketCount = 1 + Math.floor(rand() * 3);
        const buckets: Variables[] = Array.from({ length: bucketCount }, () => ({}));
        order.forEach((n, i) => {
          buckets[i % bucketCount][n] = full[n];
        });

        let ast = parse(template);
        for (const bucket of buckets) {
          ast = expandPartial(ast, bucket);
          if (rand() < 0.5) ast = deserialize(serialize(ast));
        }
        const got = render(ast);
        const want = expand(template, full);
        expect(got, `${template} :: ${JSON.stringify(full)}`).toBe(want);
        expect(got).not.toContain('%25');
      }
    }
  });

  it('every intermediate round equals the one-shot expansion so far', () => {
    const rand = pseudoRandom(7);
    for (const template of templates) {
      for (let trial = 0; trial < 40; trial++) {
        const full: Variables = {};
        for (const name of varNames) {
          if (rand() < 0.7) full[name] = pool[Math.floor(rand() * pool.length)];
        }
        const names = Object.keys(full);
        const order = names.slice().sort(() => rand() - 0.5);
        const bucketCount = 1 + Math.floor(rand() * 3);
        const buckets: Variables[] = Array.from({ length: bucketCount }, () => ({}));
        order.forEach((n, i) => {
          buckets[i % bucketCount][n] = full[n];
        });

        let ast = parse(template);
        const accumulated: Variables = {};
        for (const bucket of buckets) {
          ast = expandPartial(ast, bucket);
          Object.assign(accumulated, bucket);
          // Complete rendering after each round must be identical to a
          // one-shot expansion with exactly the variables supplied so far.
          expect(render(ast), template).toBe(expand(template, accumulated));
          // And frozen values must never have been encoded twice.
          expect(render(ast)).not.toContain('%25');
        }
      }
    }
  });
});
