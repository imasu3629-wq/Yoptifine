const { Client, GatewayIntentBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { chromium } = require('playwright-core');
const mongoose = require('mongoose');
const express = require('express');

// --- 軽量Webサーバーの起動 (Koyeb用) ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(8000, () => console.log('🚀 Keep-alive server is listening on port 8000'));

// MongoDBの接続設定
const MONGODB_URI = "mongodb+srv://imasu3629_db_user:Kai091908@cluster0.t3b7wem.mongodb.net/?appName=Cluster0";
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDBに接続しました'))
    .catch(err => console.error('❌ MongoDB接続エラー:', err));

// --- スキーマ定義 ---

const accountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    last_used_at: { type: Number, default: null } 
});
const Account = mongoose.model('Account', accountSchema);

const allowedUserSchema = new mongoose.Schema({
    user_id: { type: String, required: true, unique: true }
});
const AllowedUser = mongoose.model('AllowedUser', allowedUserSchema);

// --- ユーティリティ関数 ---

async function getAvailableAccount() {
    try {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        let accounts = await Account.find({
            $or: [
                { last_used_at: null },
                { last_used_at: { $lt: oneDayAgo, $ne: 9999999999999 } }
            ]
        });

        if (accounts.length > 0) {
            return accounts[Math.floor(Math.random() * accounts.length)];
        }

        const oldestAccount = await Account.findOne({
            last_used_at: { $ne: 9999999999999 }
        }).sort({ last_used_at: 1 });

        return oldestAccount;
    } catch (err) {
        console.error('アカウント取得エラー:', err);
        return null;
    }
}

async function updateLastUsed(email) {
    await Account.updateOne({ email: email }, { last_used_at: Date.now() });
}

async function checkUserAllowed(userId) {
    const user = await AllowedUser.findOne({ user_id: userId });
    return !!user;
}

async function banAccount(email) {
    await Account.updateOne({ email: email }, { last_used_at: 9999999999999 });
}

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

client.once('ready', async () => {
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
            },
            {
                name: 'timeout',
                description: '指定したメールアドレスのアカウントを24時間使用不可（クールダウン）にします。',
                options: [
                    { name: 'email', type: 3, description: '対象のメールアドレス', required: true }
                ]
            }
        ]);
        console.log('スラッシュコマンドの登録完了！');
    } catch (error) {
        console.error('スラッシュコマンドの登録に失敗:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
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

    if (interaction.commandName === 'timeout') {
        const allowedUsers = ['1278574483195559977', '1356921196796706981'];
        if (!allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        }

        const email = interaction.options.getString('email');
        try {
            const result = await Account.updateOne({ email: email }, { last_used_at: Date.now() });
            if (result.matchedCount > 0) {
                await interaction.reply({ content: `✅ アカウント \`${email}\` を24時間のタイムアウト状態に設定しました。`, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: `❌ アカウント \`${email}\` が見つかりませんでした。`, flags: MessageFlags.Ephemeral });
            }
        } catch (err) {
            await interaction.reply({ content: `❌ エラー: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'changecape') {
        // 3秒制限を回避するために最初に応答を保留する
        await interaction.deferReply();

        try {
            const isAllowed = await checkUserAllowed(interaction.user.id);
            if (!isAllowed) {
                return interaction.editReply({ content: `ライセンスがありません！@n8j6に許可をもらってください` });
            }
        } catch (err) {
            return interaction.editReply({ content: `❌ 権限確認中にエラーが発生しました: ${err.message}` });
        }

        const newMcid = interaction.options.getString('mcid');
        await interaction.editReply({ content: `🔍 DBから利用可能なアカウントを探しています...` });

        const account = await getAvailableAccount();
        if (!account) {
            return interaction.editReply(`❌ DBにアカウントが1つも登録されていません。先に \`/addaccount\` を実行してください。`);
        }

        // 実行者本人にだけ使用中のメールアドレスを通知
        await interaction.followUp({
            content: `現在、アカウント \`${account.email}\` を使用して移行作業を行っています。`,
            flags: MessageFlags.Ephemeral
        });

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
                    content: `移行完了後のスクリーンショットです。\n使用したアカウント: \`${account.email}\``,
                    files: ['3_result_page.png'],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                // エラー時の処理
                const adminUserId = '1278574483195559977';

                if (result.errorType === 'INVALID_CREDENTIALS') {
                    // クレデンシャルエラーの場合は、従来通りチャンネルにエラーを表示し、管理者にボタン付きDMを送る
                    await interaction.editReply({ 
                        content: `❌ 失敗: ${result.error}`,
                        embeds: [createProgressEmbed(100, `エラーが発生しました`, false, true)]
                    });
                    
                    await banAccount(account.email);
                    try {
                        const targetUser = await client.users.fetch(adminUserId);
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
                            content: `<@${adminUserId}>`,
                            embeds: [embed],
                            components: [row]
                        });
                    } catch (dmError) {
                        console.error('DMの送信に失敗しました:', dmError);
                    }
                } else {
                    // それ以外のエラーの場合（除外指定されたケース）
                    // チャンネルには詳細を出さず、管理者にDMで原因を送信する
                    await interaction.editReply({ 
                        content: `❌ 作業中にエラーが発生しました。詳細は管理者に通知されました。`,
                        embeds: [createProgressEmbed(100, `エラーが発生しました`, false, true)]
                    });

                    try {
                        const adminUser = await client.users.fetch(adminUserId);
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('❌ システムエラー通知')
                            .setDescription('マント変更作業中にエラーが発生しました。')
                            .addFields(
                                { name: '実行者', value: `${interaction.user.tag} (${interaction.user.id})` },
                                { name: '対象MCID', value: `\`${newMcid}\`` },
                                { name: '使用アカウント', value: `\`${account.email}\`` },
                                { name: 'エラー内容', value: `\`\`\`${result.error}\`\`\`` }
                            )
                            .setColor(0xFF0000)
                            .setTimestamp();
                        
                        await adminUser.send({ embeds: [errorEmbed] });
                    } catch (dmError) {
                        console.error('管理者へのDM送信に失敗しました:', dmError);
                    }
                }
            }
        } catch (error) {
            console.error(error);
            const adminUserId = '1278574483195559977';
            await interaction.editReply({ 
                content: `❌ 重大なエラーが発生しました。詳細は管理者に通知されました。`,
                embeds: [createProgressEmbed(100, `重大なエラーが発生しました`, false, true)]
            });

            try {
                const adminUser = await client.users.fetch(adminUserId);
                await adminUser.send(`⚠️ **重大なエラー報告**\n実行者: ${interaction.user.tag}\nエラー: \`${error.message}\``);
            } catch (dmError) {
                console.error('管理者へのDM送信に失敗しました:', dmError);
            }
        }
    }
});

async function changeOptifineCape(email, password, mcid, onProgress) {
    const wsEndpoint = "wss://brd-customer-hl_c032c140-zone-scraping_browser1:9nhjyzt7ypl5@brd.superproxy.io:9222/";

    let browser;
    try {
        if (onProgress) await onProgress(10, 'ブラウザへの接続を確立中...');
        browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 45000 });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        
        if (onProgress) await onProgress(30, 'ログインページへ移動中...');
        await page.goto('https://optifine.net/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        // 人間アピール：マウスを少し動かす
        await page.mouse.move(Math.random() * 500, Math.random() * 500);
        await page.waitForTimeout(1000 + Math.random() * 2000);

        if (onProgress) await onProgress(50, 'ログインフォームを確認中...');
        try {
            await Promise.race([
                page.waitForSelector('input[name="password"]', { state: 'visible', timeout: 45000 }),
                page.waitForSelector('iframe[src*="cloudflare"]', { timeout: 45000 }),
                page.waitForSelector('text=Verify you are human', { timeout: 45000 })
            ]);
        } catch (e) {
            console.log('待機タイムアウト。');
        }

        if (onProgress) await onProgress(70, 'ログイン情報を入力中...');
        const passField = await page.$('input[name="password"]');
        if (!passField) {
            await page.screenshot({ path: 'login_error_state.png' });
            throw new Error('ログインフォーム（パスワード欄）が見つかりません。Cloudflare等でブロックされている可能性があります。');
        }

        await page.fill('input[name="email"]', email);
        await page.click('input[name="password"]');
        await page.type('input[name="password"]', password, { delay: Math.random() * 50 + 50 });

        await page.waitForTimeout(500);
        if (onProgress) await onProgress(80, '送信中...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
            page.evaluate(() => document.forms['login'].submit())
        ]);

        // ログイン後の安定待ち
        await page.waitForTimeout(3000);

        const dashboardHtml = await page.content();
        if (dashboardHtml.includes('Invalid') || dashboardHtml.includes('name="password"')) {
            return { success: false, error: 'メールアドレスまたはパスワードが間違っています。', errorType: 'INVALID_CREDENTIALS' };
        }

        const match = dashboardHtml.match(/capeId=([^"]+)/);
        if (!match) {
            // マントが見つからない場合、念のため再読込してみる
            await page.reload({ waitUntil: 'domcontentloaded' });
            const reloadHtml = await page.content();
            const match2 = reloadHtml.match(/capeId=([^"]+)/);
            if (!match2) return { success: false, error: 'マントが見つかりません。ログインはできましたが、このアカウントにマントがない可能性があります。' };
            return proceedWithCape(match2[1]);
        }
        
        return await proceedWithCape(match[1]);

        async function proceedWithCape(capeId) {
            console.log('✅ ログイン成功！ Cape ID:', capeId);

            if (onProgress) await onProgress(85, 'マント編集ページへ移動中...');
            
            // 直接移動の前に少し待機
            await page.waitForTimeout(2000);
            
            try {
                await page.goto(`https://optifine.net/donationCapeEdit?capeId=${capeId}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
            } catch (err) {
                console.error('Edit page navigation failed:', err);
                await page.screenshot({ path: 'error_navigation.png' });
                return { success: false, error: `編集ページへの移動に失敗しました (Timeout/403): ${err.message}` };
            }

            await page.waitForSelector('input[type="submit"]', { state: 'visible', timeout: 30000 }).catch(async (e) => {
                console.error('Submit button not found:', e);
                await page.screenshot({ path: 'error_no_submit.png' });
                throw new Error('編集ページが正しく読み込まれませんでした。');
            });
            
            const editPageHtml = await page.content();
            if (editPageHtml.match(/The cape can be moved after \d+h\./)) {
                return { success: false, error: 'このアカウントはまだ24時間たってないため使用できません' };
            }

            if (onProgress) await onProgress(95, 'マントの設定を保存中...');
            await page.evaluate(({ mcid }) => {
                document.querySelector('input[name="capeUsername"]').value = mcid;
                const checkbox = document.querySelector('input[name="capeLocked"]');
                if (checkbox && checkbox.checked) checkbox.checked = false;
            }, { mcid });

            await page.screenshot({ path: '2_filled_page.png' });
            await page.waitForTimeout(1000);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}),
                page.evaluate(() => document.querySelector('input[type="submit"]').click())
            ]);

            await page.waitForTimeout(5000); 
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

            return { success: true };
        }
    } catch (error) {
        console.error('Catch in changeOptifineCape:', error);
        return { success: false, error: error.message };
    } finally {
        if (browser) await browser.close();
    }
}

client.login(process.env.DISCORD_TOKEN);
