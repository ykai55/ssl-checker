import { CronJob } from 'cron';
import moment from 'moment';
import 'moment-timezone';
import tls, { TLSSocket } from 'node:tls'
import nodemailer from 'nodemailer';

moment.tz('Asia/Shanghai');
moment.locale('zh-cn');

async function tslConnect(host: string): Promise<TLSSocket> {
  let port = 443;
  if (host.indexOf(':') !== -1) {
    const hostAndPort = host.split(':');
    if (hostAndPort.length !== 2) {
      throw Error(`invalid host: ${host}`)
    }
    host = hostAndPort[0];
    port = parseInt(hostAndPort[1]);
    if (isNaN(port)) {
      throw Error(`invalid host: ${host}`)
    }
  }
  return new Promise((res, rej) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      res(socket);
    })
    socket.on('error', rej);
  })
}

async function getExpireTime(host: string): Promise<number> {
  try {
    const sock = await tslConnect(host);
    const cert = sock.getPeerCertificate();
    const to = new Date(cert.valid_to);
    sock.end();
    return to.getTime();
  } catch (e: any) {
    if (e.message === 'certificate has expired') {
      return 0;
    }
    console.error(e)
    throw e;
  }
}

async function sendMailToMe(subject: string, content: string) {
  const { email: { from, to } } = getConfig();
  const mailer = nodemailer.createTransport({
    host: from.host,
    port: from.port,
    secure: from.secure,
    auth: from.auth,
  });
  const info = await mailer.sendMail({
    from: `${from.name} <${from.auth.user}>`,
    to,
    subject,
    html: content,
  });
  console.info(`email sent [id=${info.messageId}]`);
}

function convertToHTMLList(list: string[][]) {
  let htmlString = "<ul>";
  list.forEach(item => {
    htmlString += `<li><strong>${item[0]}</strong>: ${item[1]}</li>`;
  });
  htmlString += "</ul>";
  return htmlString;
}

const MIN = 60 * 1000;
const HOUR = MIN * 60;
const DAY = HOUR * 24;

interface Config {
  email: {
    from: {
      name: string,
      host: string,
      port: number,
      secure: boolean,
      auth: {
        user: string,
        pass: string,
      }
    },
    to: string
  },
  hosts: string[],
}

let _config: Config | null = null;

function getConfig() {
  if (!_config) {
    _config = require('../config.json');
  }
  return _config!;
}

async function checkAll() {
  console.log('checking all hosts...');
  const content: [string, string][] = [];
  const now = Date.now();
  const items: [string, number][] = await Promise.all(
    getConfig().hosts.map(async host =>
      [host, await getExpireTime(host)]))
  items.sort((a, b) => a[1] - b[1]);
  let needNotify = false;
  for (const [host, expireAt] of items) {
    const diff = Math.round((expireAt - now) / DAY);
    if (diff < 0) {
      // 已过期
      content.push([host, '<span style="color: red;">已过期！</span>'])
    } else if (diff < 30) {
      // 一个月内过期
      content.push([host, `${moment(expireAt).fromNow()}过期`])
    }
    needNotify = needNotify || diff <= 14;
  }
  if (needNotify) {
    const html = convertToHTMLList(content);
    await sendMailToMe(`[${content.length}🚨] SSL 证书到期检测`, html);
  }
}

function main() {
  if (process.env['RUN'] === '1') {
    console.log('run now...');
    checkAll().then();
    return;
  }
  console.log('start checking per 10min...');
  CronJob.from({
    cronTime: '0 10 * * *',
    onTick: checkAll,
    start: true,
    timeZone: 'Asia/Shanghai',
  });
}

main();
