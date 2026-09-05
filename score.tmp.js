"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const invoice_match_1 = require("./src/ai/invoice/invoice-match");
const p = (id, name) => ({ id, name, barcode: null, code: null, quantityType: 'piece', priceIn: 0, priceOut: 0 });
const idx = new invoice_match_1.CatalogIndex([
    p('1', 'Coca Cola 1L'), p('2', 'Coca Cola 0.5L'), p('3', 'Sut Nestle 1l'),
    p('4', 'Non oddiy'), p('5', 'Choy Lipton 100g'), p('6', 'Shakar 1 kg'),
]);
for (const q of ['Кока-Кола 1л', 'Coca-Cola 1 L', 'Кока кола 0,5 л', 'Сут Нестле 1 л', 'Sut 1l', 'Нон', 'Чой Липтон 100 гр', 'Sахар 1 кг', 'Пепси 1л']) {
    console.log(`"${q}"  ->  [${(0, invoice_match_1.foldForMatch)(q)}]`);
    const hits = idx.find(q, null);
    if (!hits.length) {
        console.log('       (nomzod yo\'q)');
        continue;
    }
    for (const h of hits.slice(0, 3))
        console.log(`       ${h.score.toFixed(2)}  ${h.name}${h.score >= 0.55 ? '   <== MOS' : ''}`);
}
//# sourceMappingURL=score.tmp.js.map