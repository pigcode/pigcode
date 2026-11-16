const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
const encoder = new TextEncoder()

export function countText(text: string) {
  let words = 0
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) words += 1
  }
  return {
    words,
    characters: Array.from(text).length,
    lines: text === "" ? 0 : text.split(/\r\n|\r|\n/u).length,
    bytes: encoder.encode(text).byteLength,
  }
}
