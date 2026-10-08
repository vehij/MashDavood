import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateDirection, markdownDirectionText, detectDirection } from '../src/renderer/direction.mjs'

const cases = [
  ['A و B اولویت پوشش دارد. در نمونه، مشتری دارای عامل و فرم با معیار اصلی یکسان بررسی می‌شود.', 'rtl'],
  ['ADLAS در حداقل مستقل شمرده نمی‌شود.', 'rtl'],
  ['سلام is the Persian word for hello.', 'ltr'],
  ['این متن با AI و CI نوشته می‌شود.', 'rtl'],
  ['A–S', 'ltr'],
  ['English heading', 'ltr'],
  ['عنوان فارسی', 'rtl'],
  ['این متن https://example.com/a/very/long/English/path و test@example.com دارد.', 'rtl'],
  ['https://example.com/long/english/path', 'ltr'],
  ['test@example.com', 'ltr'],
  ['Hello ۱۲۳ world', 'ltr'],
  ['۱۲۳ ٤٥٦ ...', null],
  ['؟،؛ ـ َ ّ', null],
  ['', null],
  ['مرحبا بالعالم', 'rtl'],
  ['שלום עולם', 'rtl'],
  ['Привет мир', 'ltr'],
  ['فارسی می‌تواند نیم‌فاصله داشته‌باشد.', 'rtl'],
  ['one two three چهار پنج', 'ltr'],
  ['one two سه چهار', 'rtl']
]

for (const [text, direction] of cases) {
  test(`جهت متن: ${text || 'خالی'}`, () => assert.equal(estimateDirection(text, null), direction))
}

test('کد، فرمول و مقصد پیوند در برآورد متن مارک‌داون وارد نمی‌شوند', () => {
  const text = '- [x] **AI** و [B](https://example.com/english/path) در این متن فارسی هستند. `long English code snippet here` $x+y+z=1$'
  assert.equal(estimateDirection(markdownDirectionText(text)), 'rtl')
  assert.equal(estimateDirection(markdownDirectionText('`one two three four` $alpha+beta$ فارسی')), 'rtl')
})

test('کد چندخطی جهت پیش‌فرض سند را عوض نمی‌کند', () => {
  assert.equal(detectDirection('```js\nconst one = two;\nconst three = four;\n```\n\nمتن فارسی'), 'rtl')
  assert.equal(detectDirection(''), 'ltr')
  assert.equal(detectDirection('۱۲۳'), 'ltr')
})
