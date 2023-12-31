import axios from "axios";
import { Page } from "puppeteer";
import { Stats, ipWorker } from "./app";
import { reportAlreadyUsed, reportGeoIssue } from "./proxy_provider";

export async function checkIfServerDown(page: Page): Promise<boolean> {
    // check if url is https://www.antenne.de/programm/aktionen/pausenhofkonzerte/uebersicht
    const url = page.url();
    const isDown = url === 'https://www.antenne.de/programm/aktionen/pausenhofkonzerte/uebersicht';
    return isDown;
}

export async function checkIfNachtruhe(page: Page): Promise<boolean> {
    const svgElement = await page.$('svg.c-form__message-icon use[href$="#moon"]');
    const moonVisible = svgElement !== null;

    // check if text Nachtruhe is visible
    const divElement = await page.$('div.l-grid__cell.l-grid__cell--auto h3 + p');
    const nachtruheVisible = divElement !== null;

    return moonVisible && nachtruheVisible;
}

export async function checkIfSuccess(page: Page): Promise<boolean> {
    const success1 = await page.$('svg.c-form__message-icon use[href$="#check"]');
    const h3Elements = await page.$$eval('h3', (elements) => {
        return elements.filter((element) => element.textContent?.trim() === 'Das hat geklappt!');
    });
    const success2 = h3Elements.length > 0;
    return success1 !== null && success2;
}

export async function getIssue(page: Page): Promise<string> {
    const firstParagraphElement = await page.$('fieldset.c-form__inner p');
    const pElement = firstParagraphElement ? await page.evaluate(element => element.textContent?.trim(), firstParagraphElement) : undefined;
    return pElement || '';
}

export async function checkForIssue(page: Page, reason: string): Promise<boolean> {
    const success1 = await page.$('svg.c-form__message-icon use[href$="#warning"]');
    const h3Elements = await page.$$eval('h3', (elements) => {
        return elements.filter((element) => element.textContent?.trim() === 'Fehler');
    });
    const success2 = h3Elements.length > 0;
    const firstParagraphElement = await page.$('fieldset.c-form__inner p');
    const pElement = firstParagraphElement ? await page.evaluate(element => element.textContent?.trim(), firstParagraphElement) : null;
    const success3 = pElement !== null && pElement!.includes(reason);
    return success1 !== null && success2 && success3;
}


export async function performAction(page: Page, loop: boolean = true, ip: string, stats: Stats): Promise<void> {


    await page.setRequestInterception(true);

    const blockResourceType = ["image", "media", "font"];
    const blockResourceName = [
        "quantserve",
        "adzerk",
        "doubleclick",
        "adition",
        "exelator",
        "sharethrough",
        "cdn.api.twitter",
        "google-analytics",
        "googletagmanager",
        "google",
        "fontawesome",
        "facebook",
        "analytics",
        "optimizely",
        "clicktale",
        "mixpanel",
        "zedo",
        "clicksor",
        "tiqcdn",
    ];

    const blockRequests = [
        'https://www.antenne.de/dist/websites/asap-v21-latin-700.woff2',
        'https://www.antenne.de/logos/google-play-store/badge.svg',
        'https://www.antenne.de/logos/apple-app-store/badge.svg',
        'https://app.usercentrics.eu/browser-ui/latest/bundle.js',
        'https://www.antenne.de/logos/station-antenne-bayern/station.svg',
        'https://www.antenne.de/api/channels',
        'https://www.antenne.de/api/xtras',
        'https://www.antenne.de/api/breaking-news',
        'https://www.antenne.de/api/metadata/now',
        'https://www.antenne.de/dist/websites/main.1dc3ugqcre7o.css',
    ];

    page.on("request", (request) => {
        const requestUrl = request.url();
        if (!request.isInterceptResolutionHandled())
            if (
                blockResourceType.includes(request.resourceType()) ||
                blockResourceName.some((resource) => requestUrl.includes(resource)) ||
                requestUrl.endsWith('.webp') ||
                requestUrl.endsWith('datastream?&platformkey=web-antenne-de') ||
                blockRequests.some((resource) => requestUrl.includes(resource))
            ) {
                request.abort();
            } else {
                request.continue();
            }
    });

    const isingUrl = 'https://www.antenne.de/programm/aktionen/pausenhofkonzerte/schulen/12545-landschulheim-schlo-ising-am-chiemsee-des-zweckverbands-bayer-landschulheime-gymnasium';
    const brechtUrl = 'https://www.antenne.de/programm/aktionen/pausenhofkonzerte/schulen/10782-stdtisches-bertolt-brecht-gymnasium-mnchen';

    await page.goto(isingUrl, {
        waitUntil: 'load',
        timeout: 15000,
    });

    const nachtruhe = await checkIfNachtruhe(page);
    if (nachtruhe) {
        console.log('🌙  Nachtruhe');
        console.log('Waiting for 10 minutes');
        await wait(5 * 60 * 1000);
        return;
    }

    let status = 0;


    function voteSuccess() {
        axios.get('https://orcalink.de/antenne-4').then(() => {
            console.log('✅  Voted successfully');
        }).catch(() => {
            console.log('❌  Could not send success to orcalink.de');
            console.log('retrying in 20 seconds');
            wait(20000).then(() => {
                axios.get('https://orcalink.de/antenne-4').then(() => {
                    console.log('✅  2nd try: Voted successfully');
                }).catch(() => {
                    console.log('❌  Aborted send success after 2nd try');
                });
            });
        });
    }



    page.on('response', async (response) => {
        try {
            const url = response.url();
            if (url.includes('danke-fuer-deine-stimme')) {
                console.log('🔵  Checking for success via page...');
                await wait(1000);
                let success = await checkIfSuccess(page);
                if (success) {
                    stats.totalVotes++;
                    status++;
                    voteSuccess();
                } else {
                    console.log('🔴  Checking for possible issues...');
                    const REASON_GEO = 'IP-Adresse außerhalb von Deutschland';
                    const REASON_ALREADY_USED = '1 Stimme innerhalb von 1 Minute';
                    const possibleReasons = [
                        REASON_GEO,
                        REASON_ALREADY_USED,
                    ];
                    let detected = false;
                    for (const reason of possibleReasons) {
                        success = await checkForIssue(page, reason);
                        if (success) {
                            console.log(`❌  Issue detected: ${reason}`);
                            if (reason === REASON_GEO) {
                                await reportGeoIssue(ip);
                                detected = true;
                                ipWorker.closeProxy(ip);
                            }
                            if (reason === REASON_ALREADY_USED) {
                                await reportAlreadyUsed(ip);
                                detected = true;
                            }
                            break;
                        }
                        console.log(`▸ ${reason} is not the issue`);
                    }
                    if (!detected) {
                        console.log('❌  Could not detect issue');
                        const issue = await getIssue(page);
                        const successreason = 'Wir haben deine Stimme gezählt.'
                        if (issue.includes(successreason)) {
                            console.log('No issues detected, html is just weird 😅');
                            voteSuccess();
                            stats.totalVotes++;
                            status++;
                            return;
                        }
                        console.log(`❌  this might be the issue: ${issue}`);
                    }
                    status--;
                }
            }
        } catch (error) {
            console.log('❌  Error while checking for success');
            console.log(error);
        }
    });

    stats.totalAttempts++;
    while (true) {
        await clickOnButtonWithText(page, 'Jetzt abstimmen');
        await wait(1000);
        await checkForCookieBanner(page);
        let clicked = false;
        let count = 0;
        while (!clicked && count < 10) {
            count++;
            await waitAndClick(page, 'label.c-embed__optinbutton.c-button.has-clickhandler', 1000);
            clicked = await waitAndClick(page, 'button[class="frc-button"]', 1000);
        }
        console.log('🔵  Waiting for captcha to be solved...');
        await clickOnButtonWithText(page, 'Hier klicken zum Start');
        await checkForCookieBanner(page);
        const UNSTARTED = '.UNSTARTED';
        let value = UNSTARTED;
        let x = 0;
        while ((value === UNSTARTED || value === '.UNFINISHED' || value === '.FETCHING') && x < 80) {
            x++;
            if (x % 10 === 0) { 
                console.log(`🔵  Still waiting for captcha to be solved... (${x*500}ms)`);
            }
            try {
                value = await page.$eval('.frc-captcha-solution', (el) => el.getAttribute('value')) ?? UNSTARTED;
            } catch (error) {
                console.log('🔴  Error while waiting for captcha to be solved: ', error);
                await checkForCookieBanner(page);
            }
            await wait(500);
        }
        console.log('🔵  Captcha solved');
        await waitAndClick(page, 'button[type="submit"][id="votingButton"]', 15000);

        if (!loop) {
            const maxWaitMs = 10000;
            let x = 0;
            // wait till votesInThisSession is greater than 0
            while (status === 0 && x < maxWaitMs) {
                await wait(500);
                x += 500;
            }
            await wait(1000);
            return;
        } else {
            await wait(61000, 64000);
        }
    }
}


export async function checkForCookieBanner(page: Page) {
    try {
        const parentElement = await page.$('#usercentrics-root');
        const shadowRoot = await page.evaluateHandle(parent => parent!.shadowRoot, parentElement);
        const targetElement = await shadowRoot.asElement()!.$('button[data-testid="uc-accept-all-button"]');
        await targetElement!.click();
        console.log('removed cookie banner');
        const down = await checkIfServerDown(page);
        if (down) {
            console.log('Server down, waiting 2 minutes');
            await page.close();
            await wait(2 * 60 * 1000);
        }
    } catch (error) {
    }
}

export async function waitAndClick(page: Page, selector: string, timeout: number = 15000): Promise<boolean> {
    try {
        await page.waitForSelector(selector, {
            timeout,
            visible: true,
        });
        await wait(800);
        await checkForCookieBanner(page);
        await page.click(selector);
        wait(500);
        return true;
    } catch (error) {
        console.log(`🟡  Error while waiting for selector ${selector}, ${error}`);
        return false;
    }
}


export async function clickOnButtonWithText(page: Page, text: string): Promise<boolean> {
    await checkForCookieBanner(page);
    var buttons = await page.$$('button');
    for (var i = 0; i < buttons.length; i++) {
        var buttonInnerText = await buttons[i].evaluate(node => node.innerText);
        if (buttonInnerText) {
            if (buttonInnerText.trim() === text) {
                await buttons[i].click();
                return true;
            }
        }
    }
    return false;
}



export function wait(minDelay: number, maxDelay?: number, callback?: (handler: NodeJS.Timeout) => void): Promise<void> {
    const delay = maxDelay ? Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay : minDelay;
    return new Promise((resolve) => {
        const handler = setTimeout(() => {
            if (callback) {
                callback(handler);
            }
            resolve();
        }, delay);
    });
}