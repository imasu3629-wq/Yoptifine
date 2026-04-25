require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const { chromium } = require('playwright-core');

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
                description: 'OptiFineのマントを指定したMCIDに移動します。',
                options: [
                    { name: 'email', type: 3, description: 'OptiFineのメールアドレス', required: true },
                    { name: 'password', type: 3, description: 'OptiFineのパスワード', required: true },
                    { name: 'mcid', type: 3, description: '新しくマントを適用したいMCID', required: true },
                ]
            }
        ]);
        console.log('スラッシュコマンドの登録完了！');
    } catch (error) {
        console.error('スラッシュコマンドの登録に失敗:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'changecape') {
        const email = interaction.options.getString('email');
        const password = interaction.options.getString('password');
        const newMcid = interaction.options.getString('mcid');

        await interaction.reply({ content: `処理を開始します... \`${newMcid}\` にマントを移動中。\n☁️ Bright Dataのクラウドブラウザ(Scraping Browser)を起動しています...`, flags: MessageFlags.Ephemeral });

        try {
            const result = await changeOptifineCape(email, password, newMcid);
            if (result.success) {
                await interaction.editReply(`✅ 成功！マントを \`${newMcid}\` に移動しました。`);
            } else {
                await interaction.editReply(`❌ 失敗: ${result.error}`);
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply(`❌ エラー: ${error.message}`);
        }
    }
});

// ============================================================
// OptiFineのマント変更処理 (Scraping Browser版)
// ============================================================

async function changeOptifineCape(email, password, mcid) {
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

        console.log('1. ログインページへアクセス中...');
        await page.goto('https://optifine.net/login', { waitUntil: 'domcontentloaded' });
        
        // パスワード入力欄が表示されるまで待つ（この間にBright DataがCloudflareを全自動で突破してくれます）
        console.log('Cloudflareの自動突破を待機中...');
        await page.waitForSelector('input[name="password"]', { state: 'visible', timeout: 60000 });
        console.log('✅ Cloudflare突破・ログイン画面表示！');

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
            return { success: false, error: 'メールアドレスまたはパスワードが間違っています。' };
        }

        const match = dashboardHtml.match(/capeId=([^"]+)/);
        if (!match) return { success: false, error: 'マントが見つかりません。' };
        const capeId = match[1];

        console.log('✅ ログイン成功！');
        
        // ---------------------------------------------------------
        // ここからマント編集ページに移動し、実際の画面で操作を行います
        // ---------------------------------------------------------
        console.log('3. マント編集ページへ移動中...');
        // ここは普通に画面を開く
        await page.goto(`https://optifine.net/donationCapeEdit?capeId=${capeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // 保存ボタンが表示されるまで待機（これでページが確実に開いたか確認）
        await page.waitForSelector('input[type="submit"]', { state: 'visible', timeout: 30000 });
        
        // 【可視化】入力前の画面を撮影
        await page.screenshot({ path: '1_edit_page.png' });

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
        if (resultHtml.includes('not found') || resultHtml.includes('Error')) {
            return { success: false, error: '保存に失敗しました。MCIDが存在しない可能性があります。' };
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
