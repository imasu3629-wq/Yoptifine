require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { chromium } = require('playwright-core');
const sqlite3 = require('sqlite3').verbose();

// DBの初期化（Botと同じフォルダに accounts.db というファイルが作られます）
const db = new sqlite3.Database('./accounts.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        email TEXT PRIMARY KEY,
        password TEXT,
        last_used_at INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS allowed_users (
        user_id TEXT PRIMARY KEY
    )`);
});

// 利用可能なアカウントをDBから取得する関数
function getAvailableAccount() {
    return new Promise((resolve, reject) => {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        
        // 1. まず「24時間以上使われていない（または未使用の）」かつBANされていないアカウントからランダムに1つ取得
        db.get(`SELECT * FROM accounts WHERE last_used_at IS NULL OR (last_used_at < ? AND last_used_at != 9999999999999) ORDER BY RANDOM() LIMIT 1`, [oneDayAgo], (err, row) => {
            if (err) return reject(err);
            if (row) return resolve(row);

            // 2. もし全部が24時間以内に使われていた場合、一番最後に使われた日時が古いもの（一番順番が最初に来たもの、かつBANされていないもの）を取得
            db.get(`SELECT * FROM accounts WHERE last_used_at IS NULL OR last_used_at != 9999999999999 ORDER BY last_used_at ASC LIMIT 1`, [], (err, oldestRow) => {
                if (err) return reject(err);
                resolve(oldestRow);
            });
        });
    });
}

// 使用したアカウントの最終利用時間を更新する関数
function updateLastUsed(email) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE accounts SET last_used_at = ? WHERE email = ?`, [Date.now(), email], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

// ユーザーにライセンスがあるか確認する関数
function checkUserAllowed(userId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT user_id FROM allowed_users WHERE user_id = ?`, [userId], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

// アカウントを使用不可（BAN状態）にする関数
function banAccount(email) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE accounts SET last_used_at = ? WHERE email = ?`, [9999999999999, email], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

// 進捗ゲージ用Embedを作成する関数
function createProgressEmbed(percent, statusText, isDone = false, isError = false) {
    const barLength = 10;
    const filledLength = Math.round((percent / 100) * barLength);
    const emptyLength = barLength - filledLength;
    
    const bar = '='.repeat(filledLength) + '　'.repeat(emptyLength);
    let icon = '⚙️';
    let color = 0x0099FF;
    
    if (isError) {
        icon = '❌';
        color = 0xFF0000;
    } else if (isDone) {
        icon = '✅';
        color = 0x00FF00;
    }
    
    return new EmbedBuilder()
        .setTitle('OptiFine Cape Manager')
        .setColor(color)
        .setDescription(`\`${icon} [${bar}] ${percent}%\`\\n**<${statusText}>**`);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('clientReady', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    try {
        await client.application.commands.set([
            {
                name: 'changecape',
                description: 'DBから自動でアカウントを選び、マントを指定したMCIDに移動します。',
                options: [
                    { name: 'mcid', type: 3, description: '新しくマントを適用したいMCID', required: true },
                ]
            },
            {
                name: 'addaccount',
                description: 'DBに新しいOptiFineアカウントを登録します。',
                options: [
                    { name: 'email', type: 3, description: 'OptiFineのメールアドレス', required: true },
                    { name: 'password', type: 3, description: 'OptiFineのパスワード', required: true }
                ]
            },
            {
                name: 'listaccounts',
                description: 'DBに登録されているアカウントの状態（クールダウン等）を確認します。'
            },
            {
                name: 'redeem',
                description: 'ライセンスキーを入力して機能の利用権限を取得します。',
                options: [
                    { name: 'key', type: 3, description: 'ライセンスキー', required: true }
                ]
            }
        ]);
        console.log('スラッシュコマンドの登録完了！');
    } catch (error) {
        console.error('スラッシュコマンドの登録に失敗:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    // ボタンのインタラクション処理
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('delete_account_')) {
            const emailToDelete = interaction.customId.replace('delete_account_', '');
            
            db.run(`DELETE FROM accounts WHERE email = ?`, [emailToDelete], async function(err) {
                if (err) {
                    await interaction.reply({ content: `❌ 削除中にエラーが発生しました: ${err.message}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `✅ アカウント \`${emailToDelete}\` をDBから完全に削除しました。` });
                }
            });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'addaccount') {
        const allowedUsers = ['1278574483195559977', '1356921196796706981'];
        if (!allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        }

        const email = interaction.options.getString('email');
        const password = interaction.options.getString('password');
        
        db.run(`INSERT OR REPLACE INTO accounts (email, password, last_used_at) VALUES (?, ?, NULL)`, [email, password], async function(err) {
            if (err) {
                await interaction.reply({ content: `❌ エラー: ${err.message}`, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: `✅ アカウント \`${email}\` をDBに登録しました！`, flags: MessageFlags.Ephemeral });
            }
        });
    }

    if (interaction.commandName === 'listaccounts') {
        db.all(`SELECT email, last_used_at FROM accounts ORDER BY last_used_at ASC`, [], async (err, rows) => {
            if (err) return interaction.reply({ content: `❌ エラー: ${err.message}`, flags: MessageFlags.Ephemeral });
            if (rows.length === 0) return interaction.reply({ content: '登録されているアカウントがありません。`/addaccount` で登録してください。', flags: MessageFlags.Ephemeral });

            await interaction.reply({ content: `追加されているアカウント数: ${rows.length}件`, flags: MessageFlags.Ephemeral });
        });
    }

    if (interaction.commandName === 'redeem') {
        const key = interaction.options.getString('key');
        
        if (key.toLowerCase() === 'haruisdef') {
            db.run(`INSERT OR IGNORE INTO allowed_users (user_id) VALUES (?)`, [interaction.user.id], async function(err) {
                if (err) {
                    await interaction.reply({ content: `❌ エラーが発生しました: ${err.message}`, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: `✅ 認証成功！\`/changecape\` コマンドが使用可能になりました。`, flags: MessageFlags.Ephemeral });
                }
            });
        } else {
            await interaction.reply({ content: `❌ 無効なライセンスキーです。`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'changecape') {
        try {
            const isAllowed = await checkUserAllowed(interaction.user.id);
            if (!isAllowed) {
                return interaction.reply({ content: `ライセンスがありません！@n8j6に許可をもらってください` });
            }
        } catch (err) {
            return interaction.reply({ content: `❌ 権限確認中にエラーが発生しました: ${err.message}`, flags: MessageFlags.Ephemeral });
        }

        const newMcid = interaction.options.getString('mcid');

        // 他の人にもゲージが見えるように Ephemeral を外す
        await interaction.reply({ content: `🔍 DBから利用可能なアカウントを探しています...` });

        const account = await getAvailableAccount();
        if (!account) {
            return interaction.editReply(`❌ DBにアカウントが1つも登録されていません。先に \`/addaccount\` を実行してください。`);
        }

        const onProgress = async (percent, text) => {
            // パブリックメッセージなのでメールアドレスは非表示にする
            await interaction.editReply({ content: '', embeds: [createProgressEmbed(percent, text)] }).catch(() => {});
        };

        try {
            await onProgress(10, 'ブラウザを起動中...');
            const result = await changeOptifineCape(account.email, account.password, newMcid, onProgress);
            
            if (result.success) {
                await updateLastUsed(account.email); // 成功したら最終利用時間を現在の時刻に更新
                await interaction.editReply({ 
                    content: `✅ 成功！マントを \`${newMcid}\` に移動しました。`,
                    embeds: [createProgressEmbed(100, '完了しました！', true)]
                });
                
                // 完了画面のスクショを自分だけに見える形式で送信
                await interaction.followUp({
                    content: `移行完了後のスクリーンショットです。`,
                    files: ['3_result_page.png'],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({ 
                    content: `❌ 失敗: ${result.error}`,
                    embeds: [createProgressEmbed(100, `エラーが発生しました`, false, true)]
                });
                
                if (result.errorType === 'INVALID_CREDENTIALS') {
                    // BAN状態にして選択不可にする
                    await banAccount(account.email);
                    
                    // 指定ユーザーにDMを送信
                    const targetUserId = '1278574483195559977';
                    try {
                        const targetUser = await client.users.fetch(targetUserId);
                        
                        const embed = new EmbedBuilder()
                            .setTitle('⚠️ アカウント認証エラー')
                            .setDescription('以下のOptiFineアカウントでログインに失敗しました。\nメールアドレスまたはパスワードのどちらかに誤りがあります。')
                            .addFields(
                                { name: 'メールアドレス', value: `\`${account.email}\`` },
                                { name: 'パスワード', value: `\`${account.password}\`` }
                            )
                            .setColor(0xFF0000)
                            .setTimestamp();
                            
                        const row = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`delete_account_${account.email}`)
                                    .setLabel('アカウント情報を消しますか')
                                    .setStyle(ButtonStyle.Danger)
                            );
                            
                        await targetUser.send({
                            content: `<@${targetUserId}>`,
                            embeds: [embed],
                            components: [row]
                        });
                    } catch (dmError) {
                        console.error('DMの送信に失敗しました:', dmError);
                    }
                }
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply({ 
                content: `❌ エラー: ${error.message}`,
                embeds: [createProgressEmbed(100, `重大なエラーが発生しました`, false, true)]
            });
        }
    }
});

// ============================================================
// OptiFineのマント変更処理 (Scraping Browser版)
// ============================================================

async function changeOptifineCape(email, password, mcid, onProgress) {
    const wsEndpoint = process.env.BRIGHT_DATA_BROWSER_WS_ENDPOINT;
    if (!wsEndpoint) {
        throw new Error('Bright DataのWebsocketエンドポイントが設定されていません。');
    }

    console.log('クラウドブラウザに接続中...');
    let browser;
    try {
        // Bright Dataのサーバー上にある最強のブラウザに接続する
        browser = await chromium.connectOverCDP(wsEndpoint);
        const context = await browser.newContext();
        const page = await context.newPage();

        // Cloudflareの自動突破待ちなどで時間がかかることがあるため長めに設定
        page.setDefaultTimeout(60000);

        if (onProgress) await onProgress(30, 'ログインページへ移動中...');
        console.log('1. ログインページへアクセス中...');
        await page.goto('https://optifine.net/login', { waitUntil: 'domcontentloaded' });
        
        // パスワード入力欄が表示されるまで待つ（この間にBright DataがCloudflareを全自動で突破してくれます）
        if (onProgress) await onProgress(50, 'Cloudflareを突破中...');
        console.log('Cloudflareの自動突破を待機中...');
        await page.waitForSelector('input[name="password"]', { state: 'visible', timeout: 60000 });
        console.log('✅ Cloudflare突破・ログイン画面表示！');

        if (onProgress) await onProgress(70, 'ログイン情報を送信中...');
        console.log('2. ログイン情報を送信中...');
        
        // パスワード枠への入力を監視するセキュリティをすり抜けるため、
        // 「元からあるパスワード枠を削除し、別の枠を新しく作ってパスワードを入れる」という大技を使います。
        await page.evaluate(({ email, password }) => {
            document.querySelector('input[name="email"]').value = email;
            
            // 元のパスワード枠を完全に削除する
            const oldPassField = document.querySelector('input[name="password"]');
            const parent = oldPassField.parentNode;
            parent.removeChild(oldPassField);

            // 新しい「ただのテキスト枠」を作成してパスワードを入れる
            const newPassField = document.createElement('input');
            newPassField.type = 'text'; // textにすることで監視を逃れる
            newPassField.name = 'password';
            newPassField.setAttribute('value', password);
            parent.appendChild(newPassField);
        }, { email, password });

        // フォームを送信してページが切り替わるのを待つ
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            page.evaluate(() => document.forms['login'].submit())
        ]);

        const dashboardHtml = await page.content();
        if (dashboardHtml.includes('Invalid') || dashboardHtml.includes('name="password"')) {
            return { success: false, error: 'メールアドレスまたはパスワードが間違っています。', errorType: 'INVALID_CREDENTIALS' };
        }

        const match = dashboardHtml.match(/capeId=([^"]+)/);
        if (!match) return { success: false, error: 'マントが見つかりません。' };
        const capeId = match[1];

        console.log('✅ ログイン成功！');
        
        // ---------------------------------------------------------
        // ここからマント編集ページに移動し、実際の画面で操作を行います
        // ---------------------------------------------------------
        if (onProgress) await onProgress(85, 'マント編集ページへ移動中...');
        console.log('3. マント編集ページへ移動中...');
        // ここは普通に画面を開く
        await page.goto(`https://optifine.net/donationCapeEdit?capeId=${capeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // 保存ボタンが表示されるまで待機（これでページが確実に開いたか確認）
        await page.waitForSelector('input[type="submit"]', { state: 'visible', timeout: 30000 });
        
        // 【可視化】入力前の画面を撮影
        await page.screenshot({ path: '1_edit_page.png' });

        if (onProgress) await onProgress(95, 'マントの設定を保存中...');
        console.log('4. MCIDを入力して保存ボタンを押します...');
        // 実際に画面上のテキストボックスにMCIDを入力
        await page.evaluate(({ mcid }) => {
            document.querySelector('input[name="capeUsername"]').value = mcid;
            const checkbox = document.querySelector('input[name="capeLocked"]');
            if (checkbox && checkbox.checked) checkbox.checked = false;
        }, { mcid });

        // 【可視化】入力後の画面を撮影
        await page.screenshot({ path: '2_filled_page.png' });

        // 実際に保存ボタンをクリックして送信
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'commit', timeout: 60000 }).catch(() => {}), // タイムアウトしても無視
            page.evaluate(() => document.querySelector('input[type="submit"]').click())
        ]);

        // 【可視化】保存完了後の結果画面を撮影
        await page.waitForTimeout(3000); // 結果が反映されるまで3秒待機
        await page.screenshot({ path: '3_result_page.png' });
        
        // 結果画面のHTMLを取得して本当に成功したか確認
        const resultHtml = await page.content();
        
        // エラー1: 24時間経過していない場合
        if (resultHtml.match(/The cape can be moved after \d+h\./)) {
            return { success: false, error: 'このアカウントはまだ24時間たってないため使用できません' };
        }
        
        // エラー2: MCIDが存在しない場合
        if (resultHtml.includes('Invalid Minecraft username') || resultHtml.includes('No Mojang account found')) {
            return { success: false, error: '存在しないMCIDです' };
        }

        // その他のエラー
        if (resultHtml.includes('not found') || resultHtml.includes('Error')) {
            return { success: false, error: '保存に失敗しました。' };
        }

        console.log('✅ 処理完了！(スクリーンショットを保存しました)');
        return { success: true };

    } catch (error) {
        console.error('ブラウザ操作中にエラーが発生しました:', error);
        return { success: false, error: error.message };
    } finally {
        if (browser) {
            await browser.close();
            console.log('ブラウザを終了しました。');
        }
    }
}

client.login(process.env.DISCORD_TOKEN);
