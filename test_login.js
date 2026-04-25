const { chromium } = require('playwright-core');

async function test() {
    const wsEndpoint = "wss://brd-customer-hl_c032c140-zone-scraping_browser1:9nhjyzt7ypl5@brd.superproxy.io:9222/";
    console.log('Connecting to Bright Data...');
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log('Navigating to OptiFine...');
    await page.goto('https://optifine.net/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('Waiting for email input...');
    await page.waitForSelector('input[name="email"]', { state: 'visible', timeout: 60000 });
    
    console.log('Filling email...');
    await page.fill('input[name="email"]', 'adamjarolimek@email.cz');
    
    console.log('Filling password...');
    await page.fill('input[name="password"]', 'GC5XPGUPNW');
    
    console.log('Clicking submit...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        page.click('input[type="submit"]')
    ]);
    
    const content = await page.content();
    console.log('Logged in? URL:', page.url());
    if (content.includes('Invalid username or password')) {
        console.log('Invalid credentials');
    } else {
        console.log('Success');
    }
    
    await browser.close();
}

test().catch(console.error);
