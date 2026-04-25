const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 読み込むファイルのパス
const dbPaths = [
    path.join(__dirname, 'accounts.db'),
    path.join(__dirname, 'backup', 'accounts_backup.db')
];

console.log('--- アカウント情報の抽出を開始します ---\n');

dbPaths.forEach(dbPath => {
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) return; // ファイルがない場合はスキップ

        console.log(`ファイル: ${path.basename(dbPath)}`);
        db.all("SELECT email, password FROM accounts", [], (err, rows) => {
            if (err) {
                // テーブルがない場合などはスキップ
            } else if (rows && rows.length > 0) {
                rows.forEach(row => {
                    console.log(`メール: ${row.email} | パスワード: ${row.password}`);
                });
            } else {
                console.log('（アカウントは見つかりませんでした）');
            }
            console.log('-----------------------------------');
        });
    });
});
