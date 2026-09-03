"""Generate frontend sample data straight from the audited extraction.

The UI ships with real figures from the workbook rather than invented ones, so
what a reviewer sees before Supabase is connected matches what they will see
after. Null and empty fields are dropped to keep the payload small.
"""
import json, os, collections

src = json.load(open('scripts/out/normalised.json', encoding='utf-8'))
KEEP = ['id','card','entry_type','status','review_reason','description','source_sheet',
        'source_row','txn_date','source_date_raw','date_repaired','date_repair_note',
        'supplier','supplier_country','supplier_raw','currency','original_amount',
        'currency_raw','amount_aed','direction','included_in_source_balance',
        'exchange_rate','exchange_rate_formula','occurrence','req_number','lpo_number',
        'invoice','payment_ref','account','crm','client','sales_operation','event_end','notes']

cards, txns = [], []
for i, c in enumerate(src):
    dated = [t['txn_date'] for t in c['transactions'] if t.get('txn_date')]
    s = c['summary']
    cards.append({
        'id': f"card-{i+1}",
        'name': c['card'],
        'settlementCurrency': 'AED',
        'openingBalance': s['opening_balance'],
        'openingDate': min(dated) if dated else None,
        'lastTransaction': max(dated) if dated else None,
        'sourceBalance': s['source_balance'],
        'ledgerBalance': s['ledger_balance'],
        'reconciliationDifference': s['reconciliation_difference'],
        'totalSpend': s['total_spend'],
        'totalFunding': s['total_funding'],
        'reviewAdjustmentsTotal': s['review_adjustments_total'],
        'needsReview': s['needs_review'],
        'excluded': s['excluded'],
        'transactionCount': sum(1 for t in c['transactions']
                                if t['entry_type'] == 'source_transaction'),
        'sourceHeaderRow': c['header_row'],
        'decreasingColumn': c['decreasing_column'],
        'decreasingHeader': c['decreasing_header'],
        'increasingColumn': c['increasing_column'],
        'increasingHeader': c['increasing_header'],
        'balanceFormula': c['balance_formula_sample'],
        'headerIsMisleading': c['header_is_misleading'],
        'verifiedRows': s['verified_rows'],
    })
    for j, t in enumerate(c['transactions']):
        row = {'id': f"t-{i+1}-{t.get('source_row') or j}-{t.get('occurrence',1)}",
               'cardId': f"card-{i+1}"}
        for k in KEEP:
            v = t.get(k)
            if v is None or v == '' or v is False and k in ('date_repaired',):
                continue
            row[k] = v
        row.pop('card', None)
        txns.append(row)

# Spend by original currency, per card. Never summed across currencies.
by_ccy = collections.defaultdict(lambda: {'count': 0, 'original': 0.0, 'aed': 0.0})
for t in txns:
    if t.get('direction') == 'spend' and t.get('currency'):
        k = (t['cardId'], t['currency'])
        by_ccy[k]['count'] += 1
        by_ccy[k]['original'] += t.get('original_amount') or 0.0
        by_ccy[k]['aed'] += t['amount_aed']
spend = [{'cardId': c, 'currency': cc, 'count': v['count'],
          'originalTotal': round(v['original'], 2), 'aedTotal': round(v['aed'], 2)}
         for (c, cc), v in sorted(by_ccy.items(), key=lambda kv: -kv[1]['count'])]

os.makedirs('web/src/data', exist_ok=True)
out = {'generatedFrom': '2026 Cards Monitoring.xlsx',
       'cards': cards, 'transactions': txns, 'spendByCurrency': spend}
p = 'web/src/data/ledger-sample.json'
with open(p, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
print(f"{p}: {len(cards)} cards, {len(txns)} transactions, "
      f"{len(spend)} card/currency pairs, {os.path.getsize(p)/1024:.0f} KB")
