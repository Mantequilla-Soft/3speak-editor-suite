// Whisper tidies speech up: it leaves out "um", "uh" and their kind unless the
// text it continues from (its prompt) has them. The transcript (the editor's
// "Edit by text" and "Remove fillers") wants them written down, so it starts
// whisper from a line full of them, in the spoken language. Languages not
// listed run without a prompt (their fillers may then be missing).
export const VERBATIM_PROMPTS = {
  en: 'Umm, let me think, like, hmm... Okay, uh, here is what I am, you know, thinking. Er, I mean, so, um.',
  de: 'Ähm, also, äh, ich meine, na ja, halt, hm, weißt du, ähm, sozusagen.',
  es: 'Eh, este, o sea, pues, eh, bueno, ¿sabes?, mmm, digamos, ehh.',
  fr: 'Euh, ben, en fait, euh, du coup, tu vois, hum, genre, bah, euh.',
  pt: 'Hã, tipo, né, então, é, sabe, hum, assim, tá, éé.',
  it: 'Ehm, cioè, tipo, allora, eh, insomma, diciamo, mmm, praticamente.',
  nl: 'Eh, uhm, nou, dus, zeg maar, weet je, eigenlijk, hè, ehm.',
  pl: 'Yyy, eee, no, wiesz, jakby, znaczy, yyy, tak jakby, hmm.',
  sv: 'Eh, öh, liksom, alltså, typ, ba, hmm, eh.',
  da: 'Øh, altså, ligesom, ikke, øhm, hmm, øh.',
  no: 'Eh, ehm, liksom, altså, sånn, hmm, eh.',
  fi: 'Öö, niinku, tota, siis, ööh, hmm, tavallaan.',
  cs: 'Ehm, jako, no, prostě, víš, éé, hmm.',
  ro: 'Ăă, deci, adică, păi, știi, mmm, ăăă.',
  hu: 'Ööö, hát, izé, szóval, tudod, hmm, ö.',
  ru: 'Ээ, ну, как бы, типа, то есть, вот, эм, короче.',
  uk: 'Ее, ну, як би, типу, тобто, от, ем.',
  tr: 'Ee, şey, yani, hani, ııı, hmm, işte.'
}

export const verbatimPrompt = (language) => VERBATIM_PROMPTS[String(language || '').toLowerCase()] || ''
