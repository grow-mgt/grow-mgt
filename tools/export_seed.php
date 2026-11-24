<?php
// 今までのアプリ（SQLite）の中身を、Firebase版に入れるためのJSONに書き出す。
// 使い方: php export_seed.php <app.sqlite> <出力先.json>
$p = new PDO('sqlite:' . $argv[1]);
$p->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$all = fn($sql) => $p->query($sql)->fetchAll();
$int = function (array $rows, array $keys) {
    foreach ($rows as &$r) foreach ($keys as $k) if (array_key_exists($k, $r) && $r[$k] !== null) $r[$k] = is_numeric($r[$k]) && (float)$r[$k] != (int)$r[$k] ? (float)$r[$k] : (int)$r[$k];
    return $rows;
};
// 秘密の値（パスワード、スプレッドシート連携の合言葉など）は書き出さない
$secret = ['password_hash', 'sheet_secret', 'sheet_url'];
$settings = [];
foreach ($all('SELECT key, value FROM settings') as $r) if (!in_array($r['key'], $secret, true) && !str_starts_with($r['key'], 'loginfail')) $settings[$r['key']] = $r['value'];

$items = []; foreach ($int($all('SELECT * FROM invoice_items ORDER BY invoice_id, sort, id'), ['id','invoice_id','sort','qty','price','tax_rate','amount','product_id']) as $r) { $iid = $r['invoice_id']; unset($r['invoice_id'], $r['sort']); $items[$iid][] = $r; }
$pays = []; foreach ($int($all('SELECT id, invoice_id, paid_date, amount, payer, source, created_at FROM payments ORDER BY invoice_id, paid_date, id'), ['id','invoice_id','amount']) as $r) { $iid = $r['invoice_id']; unset($r['invoice_id']); $pays[$iid][] = $r; }
$evs = []; foreach ($int($all('SELECT id, invoice_id, type, detail, created_at FROM events ORDER BY invoice_id, id'), ['id','invoice_id']) as $r) { $iid = $r['invoice_id']; unset($r['invoice_id']); $evs[$iid][] = $r; }
$invoices = $int($all('SELECT * FROM invoices ORDER BY id'), ['id','client_id','withholding','subtotal','tax','withholding_amount','total','open_count','paid_amount','business_id','incomplete']);
foreach ($invoices as &$v) { $v['items'] = $items[$v['id']] ?? []; $v['payments'] = $pays[$v['id']] ?? []; $v['events'] = $evs[$v['id']] ?? []; }
unset($v);
$out = [
    'version' => date('YmdHis'),
    'settings' => $settings,
    'businesses' => $int($all('SELECT * FROM businesses ORDER BY sort, id'), ['id','due_day','sort']),
    'clients' => $int($all('SELECT * FROM clients ORDER BY id'), ['id','price_rule_amount','business_id']),
    'products' => $int($all('SELECT * FROM products ORDER BY id'), ['id','price','cost','tax_rate','active','pack_size']),
    'clientPrices' => $int($all('SELECT client_id, product_id, price, source FROM client_prices'), ['client_id','product_id','price']),
    'recurring' => $int($all('SELECT * FROM recurring_items ORDER BY client_id, sort, id'), ['id','client_id','sort','qty','price','tax_rate']),
    'cbmLines' => $int($all('SELECT * FROM cbm_lines ORDER BY tab, sort, id'), ['id','sort','qty','cost']),
    'invoices' => $invoices,
];
file_put_contents($argv[2], json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
echo 'invoices=', count($out['invoices']), ' clients=', count($out['clients']), ' products=', count($out['products']), ' bytes=', filesize($argv[2]), "\n";
echo 'settings keys: ', implode(',', array_keys($settings)), "\n";
