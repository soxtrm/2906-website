// Fictional, browser-local educational models. Never persisted to production scores.
export const tiers = [[1, 'Unsatisfactory'], [3, 'Poor'], [5, 'Passable'], [6, 'Okay'], [7, 'Solid'], [8, 'Good'], [9, 'Very Good'], [9.5, 'Excellent'], [Infinity, 'World Class']] as const
export const tier = (raw: number) => tiers.find(([max]) => raw < max)?.[1] || 'World Class'
export const publicImpact = (rating: number) => (8.4 * 200 + rating) / 201
export const modes = {
  dine_in: { name: 'Dine-in', labels: ['Taste', 'Preparation', 'Service', 'Atmosphere', 'Presentation', 'Value'], values: [9.1, 8.7, 8.3, 8.8, 9.2, 7.6], evidence: '200 independent dining observations · fictional 30-day sample' },
  takeaway: { name: 'Takeaway', labels: ['Taste', 'Preparation', 'Pickup', 'Packaging', 'Accuracy', 'Value'], values: [8.6, 8.7, 7.8, 7.3, 9.1, 8.0], evidence: '80 independent pickup observations · fictional 30-day sample' },
  delivery: { name: 'Delivery', labels: ['Taste on Arrival', 'Temperature & Texture', 'Packaging', 'Timing', 'Accuracy', 'Value'], values: [7.4, 5.8, 5.7, 6.1, 9.0, 7.7], evidence: '40 independent delivery observations · fictional 30-day sample' },
}
export type Mode = keyof typeof modes
export const weights = { Balanced: [1/6,1/6,1/6,1/6,1/6,1/6], 'Taste first': [.4,.2,.1,.1,.1,.1], 'Reliability first': [.1,.15,.25,.2,.2,.1] }
export const reasons: Record<string, { question: string; options: string[]; category: string }> = {
  'Too greasy': { question: 'Was it the salami, the cheese, or the overall dish?', options: ['Salami', 'Cheese', 'Overall dish', 'Not sure'], category: 'Taste mismatch' },
  'Dry': { question: 'Which part felt dry?', options: ['Crust', 'Topping', 'Overall dish', 'Not sure'], category: 'Preparation / execution' },
  'Wrong texture': { question: 'How would you describe the texture?', options: ['Rubbery', 'Dry', 'Soggy', 'Too chewy', 'Other'], category: 'Preparation / execution' },
  'Too salty': { question: 'Where did you notice the salt?', options: ['Salami', 'Cheese', 'Sauce', 'Overall dish'], category: 'Taste mismatch' },
  'Salami': { question: 'What about the salami?', options: ['Too spicy', 'Too chewy', 'Too greasy', 'Not my taste'], category: 'Taste mismatch' },
  'Cheese': { question: 'What about the cheese?', options: ['Too strong', 'Rubbery', 'Too oily', 'Not my taste'], category: 'Taste mismatch' },
  'Temperature': { question: 'How did it arrive?', options: ['Cold', 'Lukewarm', 'Unevenly heated', 'Not sure'], category: 'Fulfillment / transport' },
  'Packaging': { question: 'What did you observe?', options: ['Trapped moisture', 'Crushed box', 'Leaking', 'Not sure'], category: 'Fulfillment / transport' },
  'Wrong item': { question: 'What differed from the order?', options: ['Different dish', 'Missing topping', 'Missing side', 'Not sure'], category: 'Preparation / execution' },
  'Too late': { question: 'Do you know where the delay happened?', options: ['Kitchen wait observed', 'Rider delay observed', 'Unknown'], category: 'Uncertain' },
  'Other': { question: 'Which part of the experience matters here?', options: ['My preferences', 'Preparation', 'Arrival condition', 'Uncertain'], category: 'Uncertain' },
  'Flavor balance': { question: 'What made the flavors work?', options: ['Savory salami', 'Aged cheese', 'Balanced sauce', 'The combination'], category: 'Taste match' },
  'Crisp crust': { question: 'What did you enjoy about the crust?', options: ['Crisp edge', 'Soft center', 'Light texture'], category: 'Preparation / execution' },
  'Perfect temperature': { question: 'How was it served?', options: ['Hot on arrival', 'Evenly heated', 'Just right for me'], category: 'Fulfillment / transport' },
  'Great service': { question: 'What stood out?', options: ['Attentive', 'Clear timing', 'Careful handling'], category: 'Preparation / execution' },
}
export const dishes = [
  { name: 'Spicy sausage, aged cheese & spinach', short: 'A familiar spark. A new favorite.', tags: ['Savory', 'Rich cheese', 'Tomato sauce', 'Crisp crust'], base: 9.1, novelty: .65 },
  { name: 'Char-grilled chicken & herb sauce', short: 'The sauce you love, a different canvas.', tags: ['Grilled', 'Herb sauce', 'Savory', 'Tender'], base: 8.8, novelty: .3 },
  { name: 'Roasted kale & lemon', short: 'A blank page in your taste story.', tags: ['Unknown preference', 'Roasted', 'Bright citrus'], base: null, novelty: .9 },
]
export const fit = (dish: typeof dishes[number], curiosity: number) => dish.base === null ? null : Math.min(10, Math.max(0, dish.base + (curiosity - 50) / 50 * (dish.novelty - .5) * 2))
export const verticals = {
  Food: { example: 'A burger that travels well.', dimensions: ['Taste', 'Texture', 'Preparation', 'Temperature'], insight: 'Test vented packaging. Observe the next delivery sample.' },
  Drinks: { example: 'The same cocktail. Every time.', dimensions: ['Recipe', 'Temperature', 'Dilution', 'Presentation'], insight: 'Compare ice and dilution reports across service periods.' },
  Services: { example: 'A promise that arrives on time.', dimensions: ['Punctuality', 'Workmanship', 'Communication', 'Reliability'], insight: 'Compare the booked arrival window with observed arrival.' },
  Experiences: { example: 'The experience behind the photograph.', dimensions: ['Timing', 'Description', 'Accessibility', 'Value'], insight: 'Review where the description and guest observations differ.' },
}
