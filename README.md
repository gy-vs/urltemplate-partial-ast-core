# URI template core

TypeScript library for RFC 6570 URI template expansion (levels 1–4) with
**partial expansion**: a template can be expanded with only some variables,
keeping the rest as a processable template AST.

Run `npm install`, then `npm test` and `npm run build`.

## One-shot expansion

```ts
import { expand } from './src/index.js';

expand('/{id}', { id: 'a b' });            // '/a%20b'
expand('{?q,page}', { q: 'a b', page: 2 }); // '?q=a%20b&page=2'
expand('{/path*}', { path: ['a', 'b'] });   // '/a/b'
```

## Partial expansion

Unknown variables are **not** flattened into a concatenated string. They stay
inside the expression node, retaining their position and modifiers, so they can
be resolved in later rounds:

```ts
import { expandPartial, render, serialize, deserialize } from './src/index.js';

let ast = expandPartial('/search{?q,page,size}', { page: 2 });
render(ast, { complete: false }); // '/search{?q,size}&page=2'

ast = expandPartial(ast, { q: 'hello world' });
render(ast, { complete: false }); // '/search?q=hello%20world&page=2{&size}'

ast = expandPartial(ast, { size: 50 });
render(ast);                      // '/search?q=hello%20world&page=2&size=50'
```

The expression node records:

- `operator` — the RFC 6570 operator (`'' | + | # | . | / | ; | ? | &`);
- `specs` — the variable specifications in template order, each with its
  `explode` (`*`) and `prefix` (`:n`) modifiers;
- `terms` — per-variable state: `pending` (never provided), `missing`
  (explicitly provided as `undefined`) or `text` (a frozen, already-encoded
  contribution with no leading separator);
- `started` — the consumed-separator state.

Because separators (operator prefixes like `?`/`#` and separators like `,`/`&`)
are derived from the frozen terms while rendering — never stored inside a term —
re-expanding a partial AST cannot produce duplicate `?`, `#` or commas, and
already-emitted values are never percent-encoded a second time.

Finishing a partially expanded AST with `render(ast)` (complete mode, the
default) is always equal to expanding the original template once with all the
accumulated variables.

### Explicit `undefined` vs. not provided

```ts
// Key present, value undefined: the variable is decided and contributes
// nothing, even if a value is supplied in a later round.
expandPartial('{?a,b}', { a: undefined, b: '2' }); // ?b=2

// Key absent entirely: the variable stays pending.
expandPartial('{?a,b}', { b: '2' });               // {?a}&b=2
```

### Serialization

The AST is plain JSON data:

```ts
const json = serialize(ast);
ast = deserialize(json); // validated
```
