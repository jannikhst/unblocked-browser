import axios from "axios";
import { wait } from "./action";
import { MockedTorInstance, TorConfig, TorInstance } from "./tor";
import { Proxy, ProxyProvider, base, getUnusedIp } from "./proxy_provider";

export class IpWorker extends ProxyProvider{
    private torInstances: { [key: string]: TorInstance } = {};

    async createProxy(): Promise<Proxy> {
        console.log('🛜  Creating tor instance...');
        const config: TorConfig = {
            ExitNodes: ['de'],
            StrictNodes: true,
        };
        const temporaryWaitlist: TorInstance[] = [];
        const geoIssues = await getGeoIssues();
        while (true) {
            const tor = await TorInstance.create(config);
            // check if instance already exists
            const endpoint = tor.info.ip;
            console.log(`🤖  Created tor instance ${tor.info.info}`);
            if (this.torInstances[endpoint] || geoIssues.includes(endpoint)) {
                console.log('🟡  Had issues with this IP before, switching...');
                await tor.close();
                console.log('🟡  Closed instance:', tor.info.ip);
                await wait(200);
                continue;
            }
            this.torInstances[endpoint] = tor;
            await registerIp(endpoint);

            console.log(`🟢  Checking waitlist... (${temporaryWaitlist.length} instances)`);
            const waitListIp = await getUnusedIp(56000, temporaryWaitlist.map(t => t.info.ip));
            if (waitListIp) {
                console.log(`🟢  Found unused IP in waitlist: ${waitListIp}`);
                return tor;
            }
            const check = await checkIfNewTorInstanceIsUsedBySomeoneElse(endpoint, 55000);
            if (check) {
                temporaryWaitlist.push(tor);
                console.log(`🟡  Someone else is using this IP, but we keep it open for later...`);
                continue;
            } else {
                // try to reserve it
                const reserved = await getUnusedIp(55000, [endpoint]);
                if (reserved === undefined) {
                    console.log(`🟡  Could not reserve IP, but we keep it open for later...`);
                    temporaryWaitlist.push(tor);
                    continue;
                }
            }
            return tor;
        }
    }

    async prepare(count: number): Promise<void> {
        console.log(`🟢  Preparing ${count} connections...`);
        const tasks: Promise<any>[] = [];
        for (let i = 0; i < count; i++) {
            tasks.push(this.createProxy());
        }
        await Promise.all(tasks);
        console.log(`🟢  Prepared ${count} connections.`);
    }

    async closeProxy(endpoint: string): Promise<void> {
        console.log(`🟠 Closing tor instance ${endpoint}`);
        const tor = this.torInstances[endpoint];
        delete this.torInstances[endpoint];
        if (tor) {
            await tor.close();
        }
    }

    async getUnusedProxy(age: number, ownIp?: string): Promise<Proxy> {
        const available = Object.keys(this.torInstances);
        if (ownIp) {
            available.push(ownIp);
        }
        const ip = await getUnusedIp(age, available);
        if (ip) {
            console.log(`🟢  Got unused IP from manager: ${ip}`);
        } else {
            console.log(`🆕  No unused IP available, creating new one...`);
        }
        if (ip !== undefined && ip === ownIp) {
            // we can use our own IP
            console.log(`🟢 📣  Using own IP ${ip}`);
            return new MockedTorInstance(ip);
        }
        if (ip) {
            console.log(`🛜  Reusing tor instance ${ip}`);
            return this.torInstances[ip];
        }
        return await this.createProxy();
    }
}


async function registerIp(ip: string): Promise<void> {
    const url = base + '/register-ip?ip=' + ip;
    await axios.get(url);
}

async function getGeoIssues(): Promise<string[]> {
    const url = base;
    const res = await axios.get(url);
    return [...(res.data.geoIssues ?? []), ...(res.data.tempBlocked ?? [])];
}



async function checkIfNewTorInstanceIsUsedBySomeoneElse(ip: string, unusedSince: number): Promise<boolean> {
    const res = await axios.get(base);
    const ips = res.data.ips as { [key: string]: string };
    // map to as { [key: string]: Date }
    const dateMap: { [key: string]: Date } = {};
    for (const key in ips) {
        dateMap[key] = new Date(ips[key]);
    }
    const now = new Date();
    const usedIp = dateMap[ip];
    if (!usedIp) {
        return false;
    }
    const diff = now.getTime() - usedIp.getTime();
    return diff < unusedSince;
}


//git clone https://github.com/jannikhst/unblocked-browser.git && cd unblocked-browser && ./builder.sh