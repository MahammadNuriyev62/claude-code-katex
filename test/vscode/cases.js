const R = String.raw;
const sections = Array.from({ length: 12 }, (_, i) => R`### Section ${i + 1}

$$\Big[\sum_{k=1}^{n}k^2\Big]=\frac{n(n+1)(2n+1)}6$$
$\vert x_${i + 1}\vert$

| Quantity | Value |
| --- | --- |
| Norm | $\vert x\vert$ |
| Scale | $10^{-4}$ |

> ⚠️ A warning beside inline $\sqrt{1+x^2}$.

`).join('');

const cases = [
  { name: 'adjacent display and inline', markdown: '$$x$$\n$y$', count: 2 },
  { name: 'multiple display lines and trailing inline', markdown: '$$x$$\n$$y$$\n$z$', count: 3 },
  { name: 'bracket delimiters and inline fraction', markdown: R`\[x^2\]
$\frac{a}{b}$`, count: 2 },
  { name: 'tall inline, currency and literal code', markdown: R`Tall $\frac{a}{b}$, $\sqrt{1+x^2}$, $\large x$, $\overrightarrow{AB}$; $5 stays money and ` + '`$x$` stays code.', count: 4,
    text: ['$5 stays money', '$x$'] },
  { name: 'long tables, quotes and math', markdown: sections, count: 60, tables: 12 },
  { name: 'lists and multiline matrix', markdown: R`1. A matrix:

   $$\begin{pmatrix}
   1 & 2 \\
   3 & 4
   \end{pmatrix}$$

2. Inline $\frac{1}{2}$ stays in its list.`, count: 2 },
  { name: 'fenced code remains verbatim', markdown: '```tex\n$$x$$\n$y$\n\\[z\\]\n```\n\nActual $z^2$.', count: 1,
    code: '$$x$$\n$y$\n\\[z\\]' },
];

const interaction = R`Inline $E=mc^2$ and $\frac{a}{b}$.

$$\int_0^1 x^2\,dx=\frac13$$

$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$

End of examples.`;

module.exports = { cases, interaction };
