const DIV_TOBACCO = 'Tobacco';
const HQ_CITY = 'Sector-12';

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const c = ns.corporation;
    try {
        if (!c?.hasCorporation?.() || !c.hasCorporation()) return;
    } catch {
        return;
    }

    try {
        const corp = c.getCorporation();
        if (!corp?.divisions?.includes(DIV_TOBACCO)) return;
    } catch {
        return;
    }

    let division;
    try {
        division = c.getDivision(DIV_TOBACCO);
    } catch {
        return;
    }

    const products = Array.isArray(division?.products) ? division.products : [];
    if (products.length <= 0) return;

    let hasTa2 = false;
    let hasTa1 = false;
    try { hasTa2 = c.hasResearched(DIV_TOBACCO, 'Market-TA.II'); } catch { }
    try { hasTa1 = hasTa2 || c.hasResearched(DIV_TOBACCO, 'Market-TA.I'); } catch { }

    for (const productName of products) {
        try {
            const product = c.getProduct(DIV_TOBACCO, HQ_CITY, productName);
            if (Number(product?.developmentProgress ?? 0) < 100) continue;
            if (hasTa2) c.setProductMarketTA2(DIV_TOBACCO, productName, true);
            else if (hasTa1) c.setProductMarketTA1(DIV_TOBACCO, productName, true);
            for (const city of division.cities ?? []) {
                c.sellProduct(DIV_TOBACCO, city, productName, 'MAX', 'MP', true);
            }
        } catch { }
    }
}
