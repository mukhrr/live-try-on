// JoyAI's RV2V instructions name the garment ("Put the coat/dress/shirt from Image 1 on the model...").
// Shops name products in English, Russian or Uzbek, so map common words to the English noun.
const GARMENTS: [RegExp, string][] = [
  [/\bhood(ie|y)\b|худи|толстовк|xudi/i, "hoodie"],
  [/\bt-?shirt\b|\btee\b|футболк|futbolka/i, "t-shirt"],
  [/\bblazer\b|пиджак|жакет/i, "blazer"],
  [/\bsuit\b/i, "suit"],
  // Russian and Uzbek "костюм" is any matching set, tracksuits included, not a formal suit.
  [/костюм|kostyum/i, "outfit"],
  [/\bcoat\b|\btrench\b|пальто|плащ|palto/i, "coat"],
  [/\bjacket\b|\bparka\b|\bbomber\b|куртк|kurtka/i, "jacket"],
  [/\bsweat(er|shirt)\b|\bjumper\b|\bpullover\b|\bcardigan\b|свитер|джемпер|кардиган|sviter/i, "sweater"],
  [/\bdress\b|плать|сарафан/i, "dress"],
  [/\bshirt\b|\bblouse\b|рубашк|блуз|ko'?ylak/i, "shirt"],
  [/\bjeans\b|джинс|jinsi/i, "jeans"],
  [/\bpants\b|\btrousers\b|\bchinos\b|брюк|штан|shim\b/i, "trousers"],
  [/\bskirt\b|юбк/i, "skirt"],
  [/\bshorts\b|шорт/i, "shorts"],
  [/\bvest\b|\bgilet\b|жилет/i, "vest"],
];

export function garmentNoun(text: string): string | null {
  for (const [re, noun] of GARMENTS) if (re.test(text)) return noun;
  return null;
}

/** productName is " | "-joined, most specific source first; a site-wide page title shouldn't outrank the alt text. */
export function instructionFor(productName: string): string {
  const noun = productName.split(" | ").map(garmentNoun).find(Boolean);
  return `Put the ${noun ?? "clothes"} from Image 1 on the model in the video`;
}
