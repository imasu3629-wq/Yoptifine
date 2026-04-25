require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { chromium } = require('playwright-core');
const mongoose = require('mongoose');
const sqlite3 = require('sqlite3').verbose();

// MongoDBの接続設定
const MONGODB_URI = "mongodb+srv://imasu3629_db_user:Kai091908@cluster0.t3b7wem.mongodb.net/?appName=Cluster0";
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDBに接続しました'))
    .catch(err => console.error('❌ MongoDB接続エラー:', err));

// --- スキーマ定義 ---

// アカウント情報のスキーマ
const accountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    last_used_at: { type: Number, default: null } // 9999999999999 はBAN状態
});
const Account = mongoose.model('Account', accountSchema);

// ライセンス許可ユーザーのスキーマ
const allowedUserSchema = new mongoose.Schema({
    user_id: { type: String, required: true, unique: true }
});
const AllowedUser = mongoose.model('AllowedUser', allowedUserSchema);

// --- ユーティリティ関数 ---

// 利用可能なアカウントをDBから取得する関数
async function getAvailableAccount() {
    try {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        
        // 1. まず「24時間以上使われていない（または未使用の）」かつBANされていないアカウントを取得
        let accounts = await Account.find({
            $or: [
                { last_used_at: null },
                { last_used_at: { $lt: oneDayAgo, $ne: 9999999999999 } }
            ]
        });

        if (accounts.length > 0) {
            // ランダムに1つ選ぶ
            return accounts[Math.floor(Math.random() * accounts.length)];
        }

        // 2. もし全部が24時間以内に使われていた場合、一番最後に使われた日時が古いもの（BANされていないもの）を取得
        const oldestAccount = await Account.findOne({
            last_used_at: { $ne: 9999999999999 }
        }).sort({ last_used_at: 1 });

        return oldestAccount;
    } catch (err) {
        console.error('アカウント取得エラー:', err);
        return null;
    }
}

// 使用したアカウントの最終利用時間を更新する関数
async function updateLastUsed(email) {
    await Account.updateOne({ email: email }, { last_used_at: Date.now() });
}

// ユーザーにライセンスがあるか確認する関数
async function checkUserAllowed(userId) {
    const user = await AllowedUser.findOne({ user_id: userId });
    return !!user;
}

// アカウントを使用不可（BAN状態）にする関数
async function banAccount(email) {
    await Account.updateOne({ email: email }, { last_used_at: 9999999999999 });
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
        .setDescription(`\`${icon} [${bar}] ${percent}%\`\n**<${statusText}>**`);
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
    
    // --- 移行用コード（一度実行したら削除してOK） ---
    console.log('🔄 SQLiteからMongoDBへのデータ移行を開始します...');
    const db = new sqlite3.Database('./accounts.db');
    
    // アカウントの移行
    db.all("SELECT * FROM accounts", [], async (err, rows) => {
        if (err) return console.error('SQLite読み込みエラー(accounts):', err);
        for (const row of rows) {
            await Account.findOneAndUpdate(
                { email: row.email },
                { password: row.password, last_used_at: row.last_used_at },
                { upsert: true }
            );
        }
        console.log(`✅ アカウント情報を ${rows.length} 件移行しました。`);
    });

    // 許可ユーザーの移行
    db.all("SELECT * FROM allowed_users", [], async (err, rows) => {
        if (err) return console.error('SQLite読み込みエラー(allowed_users):', err);
        for (const row of rows) {
            await AllowedUser.findOneAndUpdate(
                { user_id: row.user_id },
                { user_id: row.user_id },
                { upsert: true }
            );
        }
        console.log(`✅ 許可ユーザー情報を ${rows.length} 件移行しました。`);
        db.close(); // SQLite接続を閉じる
    });
    // --- 移行用コード終了 ---

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
            
            try {
                const result = await Account.deleteOne({ email: emailToDelete });
                if (result.deletedCount > 0) {
                    await interaction.reply({ content: `✅ アカウント \`${emailToDelete}\` をDBから完全に削除しました。` });
                } else {
                    await interaction.reply({ content: `❌ アカウントが見つかりませんでした。`, flags: MessageFlags.Ephemeral });
                }
            } catch (err) {
                await interaction.reply({ content: `❌ 削除中にエラーが発生しました: ${err.message}`, flags: MessageFlags.Ephemeral });
            }
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
        
        try {
            await Account.findOneAndUpdate(
                { email: email },
                { password: password, last_used_at: null },
                { upsert: true, new: true }
            );
            await interaction.reply({ content: `✅ アカウント \`${email}\` をDBに登録しました！`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: `❌ エラー: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'listaccounts') {
        try {
            const count = await Account.countDocuments();
            if (count === 0) {
                return interaction.reply({ content: '登録されているアカウントがありません。`/addaccount` で登録してください。', flags: MessageFlags.Ephemeral });
            }
            await interaction.reply({ content: `追加されているアカウント数: ${count}件`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: `❌ エラー: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'redeem') {
        const key = interaction.options.getString('key');
        
        if (key.toLowerCase() === 'haruisdef') {
            try {
                await AllowedUser.findOneAndUpdate(
                    { user_id: interaction.user.id },
                    { user_id: interaction.user.id },
                    { upsert: true, new: true }
                );
                await interaction.reply({ content: `✅ 認証成功！\`/changecape\` コマンドが使用可能になりました。`, flags: MessageFlags.Ephemeral });
            } catch (err) {
                await interaction.reply({ content: `❌ エラーが発生しました: ${err.message}`, flags: MessageFlags.Ephemeral });
            }
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

        await interaction.reply({ content: `🔍 DBから利用可能なアカウントを探しています...` });

        const account = await getAvailableAccount();
        if (!account) {
            return interaction.editReply(`❌ DBにアカウントが1つも登録されていません。先に \`/addaccount\` を実行してください。`);
        }

        const onProgress = async (percent, text) => {
            await interaction.editReply({ content: '', embeds: [createProgressEmbed(percent, text)] }).catch(() => {});
        };

        try {
            await onProgress(10, 'ブラウザを起動中...');
            const result = await changeOptifineCape(account.email, account.password, newMcid, onProgress);
            
            if (result.success) {
                await updateLastUsed(account.email); 
                await interaction.editReply({ 
                    content: `✅ 成功！マントを \`${newMcid}\` に移動しました。`,
                    embeds: [createProgressEmbed(100, '完了しました！', true)]
                });
                
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
                    await banAccount(account.email);
                    
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
        return { success: false, error: 'BRIGHT_DATA_BROWSER_WS_ENDPOINT が設定されていません。' };
    }

    let browser;
    try {
        browser = await chromium.connectOverCDP(wsEndpoint);
        const context = await browser.newContext();
        const page = await context.newPage();
        
        if (onProgress) await onProgress(30, 'ログインページへ移動中...');
        console.log('1. ログインページへ移動中...');
        await page.goto('https://optifine.net/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Cloudflare等のチェックを待つ
        if (onProgress) await onProgress(50, 'Cloudflareを突破中...');
        await page.waitForTimeout(5000);

        if (onProgress) await onProgress(70, 'ログイン情報を送信中...');
        console.log('2. ログイン情報を入力中...');
        await page.fill('input[name="email"]', email);
        await page.fill('input[name="password"]', password);
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
            page.click('input[type="submit"]')
        ]);

        const loginContent = await page.content();
        if (loginContent.includes('Invalid username or password')) {
            console.log('❌ ログイン失敗: メールアドレスまたはパスワードが違います');
            return { success: false, error: 'メールアドレスまたはパスワードが正しくありません。', errorType: 'INVALID_CREDENTIALS' };
        }

        const capeIdMatch = page.url().match(/capeId=([a-zA-Z0-9]+)/);
        let capeId = capeIdMatch ? capeIdMatch[1] : null;

        if (!capeId) {
            const bodyText = await page.innerText('body');
            if (bodyText.includes('Donation settings')) {
                const link = await page.$('a[href*="donationCapeEdit"]');
                if (link) {
                    const href = await link.getAttribute('href');
                    const m = href.match(/capeId=([a-zA-Z0-9]+)/);
                    if (m) capeId = m[1];
                }
            }
        }

        if (!capeId) {
            return { success: false, error: 'マントIDが見つかりませんでした。このアカウントにはマントがない可能性があります。' };
        }

        console.log('✅ ログイン成功！');
        
        if (onProgress) await onProgress(85, 'マント編集ページへ移動中...');
        await page.goto(`https://optifine.net/donationCapeEdit?capeId=${capeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('input[type="submit"]', { state: 'visible', timeout: 30000 });
        
        if (onProgress) await onProgress(95, 'マントの設定を保存中...');
        await page.evaluate(({ mcid }) => {
            document.querySelector('input[name="capeUsername"]').value = mcid;
            const checkbox = document.querySelector('input[name="capeLocked"]');
            if (checkbox && checkbox.checked) checkbox.checked = false;
        }, { mcid });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'commit', timeout: 60000 }).catch(() => {}),
            page.evaluate(() => document.querySelector('input[type="submit"]').click())
        ]);

        await page.waitForTimeout(3000); 
        await page.screenshot({ path: '3_result_page.png' });
        
        const resultHtml = await page.content();
        
        if (resultHtml.match(/The cape can be moved after \d+h\./)) {
            return { success: false, error: 'このアカウントはまだ24時間たってないため使用できません' };
        }
        
        if (resultHtml.includes('Invalid Minecraft username') || resultHtml.includes('No Mojang account found')) {
            return { success: false, error: '存在しないMCIDです' };
        }

        if (resultHtml.includes('not found') || resultHtml.includes('Error')) {
            return { success: false, error: '保存に失敗しました。' };
        }

        console.log('✅ 処理完了！');
        return { success: true };

    } catch (error) {
        console.error('エラー:', error);
        return { success: false, error: error.message };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

client.login(process.env.DISCORD_TOKEN);
