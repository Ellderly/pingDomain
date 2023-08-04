const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const { Sequelize, DataTypes } = require('sequelize');
const cron = require('node-cron');
const axios = require('axios');
const url = require('url');
const fs = require('fs')
const TelegramBot = require('node-telegram-bot-api');
const tmp = require('tmp-promise');
const cheerio = require('cheerio');

const botToken = '6411685859:AAFkL2YjP2zs8UEwJKKByjoEqQXnjI__0CA';
const chatId = '-940917715';
const bot = new TelegramBot(botToken, {polling: true});

bot.setMyCommands([
    { command: '/all', description: 'Показывает все домены' },
    { command: '/down', description: 'Показывает домены, которые не работают' },
    { command: '/domens_history', description: 'Показывает историю определенного домена' },
]);

bot.onText(/\/domens_history/, async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        bot.sendMessage(msg.chat.id, "Пожалуйста, введите название домена, чью историю вы хотите увидеть:");
        bot.once('message', async (responseMsg) => {
            const domainName = responseMsg.text;
            const domain = await Domain.findOne({
                where: { name: domainName }
            });

            if (!domain) {
                bot.sendMessage(responseMsg.chat.id, "Домен не найден!");
                return;
            }

            const history = await DomainHistory.findAll({
                where: {
                    domainId: domain.id
                },
                order: [['timestamp', 'DESC']]
            });

            let historyText = `История домена ${domainName}:\n\n`;

            history.forEach(record => {
                historyText += `Статус: ${record.status}, Время: ${new Date(record.timestamp).toLocaleString()}, Продолжительность простоя: ${record.downtime}s\n`;
            });

            // Создаем временный файл
            const tmpFile = await tmp.file({ postfix: '.txt' });

            fs.writeFile(tmpFile.path, historyText, async (err) => {
                if (err) {
                    console.error(err);
                    return;
                }
                // Отправляем файл в чат Telegram
                await bot.sendDocument(responseMsg.chat.id, fs.createReadStream(tmpFile.path));
                // Закрываем и удаляем временный файл
                await tmpFile.cleanup();
            });
        });
    }
});

const app = express();

app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'some secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite'
});

const Domain = sequelize.define('Domain', {
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    display_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false
    },
    previousStatus: {
        type: DataTypes.STRING
    },
    error: {
        type: DataTypes.STRING
    }
});



const DomainHistory = sequelize.define('DomainHistory', {
    domainId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Domain,
            key: 'id'
        }
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false
    },
    timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
    },
    downtime: {
        type: DataTypes.INTEGER,
        allowNull: false,
    }
});


const Admin = sequelize.define('Admin', {
    password: {
        type: DataTypes.STRING,
        allowNull: false
    }
});

sequelize.sync();

bcrypt.hash('111', 10, async function(err, hash) {
    const admin = await Admin.findOne();
    if(admin) {
        admin.password = hash;
        await admin.save();
    } else {
        await Admin.create({ password: hash });
    }
});

app.use(async (req, res, next) => {
    if (req.originalUrl === '/login' || req.session.admin) {
        next();
    } else {
        res.redirect('/login');
    }
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const admin = await Admin.findOne();
    const match = await bcrypt.compare(req.body.password, admin.password);
    if (match) {
        req.session.admin = true;
        res.redirect('/');
    } else {
        res.redirect('/login');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(function() {
        res.redirect('/login');
    });
});

cron.schedule('*/20 * * * * *', async () => {
    const domains = await Domain.findAll();

    const promises = domains.map(async (domain) => {
        const statusStart = Date.now();
        try {
            await Promise.race([
                axios.get(domain.name),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Превышено время ожидания')), 10000)
                ),
            ]);
            const response = await axios.get(domain.name);
            const $ = cheerio.load(response.data);
            const pingDomain = $('input[name="pingDomain"]');
            if (pingDomain.length) {
                domain.previousStatus = domain.status;
                domain.status = 'Домен доступен';
                domain.error = '';
            } else {
                throw new Error('Domain does not contain the required input field');
            }
        } catch (error) {
            domain.previousStatus = domain.status;
            domain.status = 'Ошибка';
            domain.error = error.message;
        }

        const statusEnd = Date.now();
        const downtime = (statusEnd - statusStart) / 1000;

        if (domain.previousStatus !== domain.status) {
            await DomainHistory.create({
                domainId: domain.id,
                status: domain.status,
                downtime: downtime
            });

            if (domain.status === 'Домен доступен') {
                bot.sendMessage(chatId, `URL ${domain.display_name} вновь работает.`);
            } else {
                bot.sendMessage(chatId, `URL ${domain.display_name} не отвечает. Причина: ${domain.error}`);
            }

        }

        await domain.save({fields: ['status', 'previousStatus', 'error']});
    });

    await Promise.all(promises);
});


app.get('/', async (req, res) => {
    const domains = await Domain.findAll();

    const error = req.session.error;
    req.session.error = null;

    res.render('index', { domains, error });
});
app.get('/domain/:id/history', async (req, res) => {
    const domainId = req.params.id;

    const history = await DomainHistory.findAll({
        where: {
            domainId: domainId
        },
        order: [['timestamp', 'DESC']]
    });

    res.render('history', { history });
});


app.post('/check', async (req, res) => {
    let urlObject = url.parse(req.body.name);
    let hostname = urlObject.hostname;
    let fullUrl = req.body.name;
    if (hostname === null) { // Если входная строка не является полным URL
        hostname = req.body.name; // Считаем, что входная строка - это домен
        fullUrl = `https://${hostname}`; // Делаем предположение, что это https-домен
        urlObject = url.parse(fullUrl);
    }

    urlObject.protocol = null; // Удаляем протокол из объекта URL
    let displayName = url.format(urlObject).slice(2); // Форматируем объект URL обратно в строку

    const existingDomain = await Domain.findOne({
        where: {
            name: fullUrl
        }
    });

    if (existingDomain) {
        req.session.error = "URL уже существует!";
        return res.redirect('/');
    }

    try {
        await axios.get(fullUrl);
        await Domain.create({name: fullUrl, display_name: displayName, status: 'Домен доступен', error: ''});
    } catch (httpsError) {
        try {
            fullUrl = `http://${hostname}`;
            await axios.get(fullUrl);
            urlObject = url.parse(fullUrl);
            urlObject.protocol = null;
            displayName = url.format(urlObject);
            await Domain.create({name: fullUrl, display_name: displayName, status: 'Домен доступен', error: ''});
        } catch (httpError) {
            await Domain.create({name: fullUrl, display_name: displayName, status: 'Ошибка', error: httpError.message});
            bot.sendMessage(chatId, `Новый URL ${fullUrl} не отвечает. Причина: ${httpError.message}`);
        }
    }

    res.redirect('/');
});




app.post('/delete', async (req, res) => {
    const existingDomain = await Domain.findOne({
        where: {
            name: req.body.name
        }
    });

    if (!existingDomain) {
        return res.redirect('/');
    }

    // Начало нового кода
    await DomainHistory.destroy({
        where: {
            domainId: existingDomain.id
        }
    });
    // Конец нового кода

    await Domain.destroy({
        where: {
            name: req.body.name
        }
    });
    res.redirect('/');
});



const commands = [
    { command: '/all', description: 'Показывает все домены' },
    { command: '/down', description: 'Показывает домены, которые не работают' },
];

bot.onText(/\/commands/, (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const chatId = msg.chat.id;
        const keyboard = commands.map(command => [{ text: command.command + ' - ' + command.description, callback_data: command.command }]);

        bot.sendMessage(chatId, 'Выберите команду:', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = JSON.parse(callbackQuery.data);

    if (data.command === 'getDomainHistory') {
        const history = await DomainHistory.findAll({
            where: {
                domainId: data.domainId
            },
            order: [['timestamp', 'DESC']]
        });

        let response = "История домена:\n";

        history.forEach(record => {
            response += `Статус: ${record.status}, Время: ${new Date(record.timestamp).toLocaleString()}, Продолжительность простоя: ${record.downtime}s\n`;
        });

        bot.sendMessage(chatId, response);
    }
});


bot.onText(/\/all/, async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const domains = await Domain.findAll();
        let response = "Список всех доменов:\n";

        domains.forEach(domain => {
            response += `Имя: ${domain.name}, Статус: ${domain.status}\n`;
        });

        bot.sendMessage(msg.chat.id, response);
    }
});

bot.onText(/\/down/, async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const domains = await Domain.findAll({
            where: {
                status: 'Ошибка'
            }
        });

        if (domains.length === 0) {
            bot.sendMessage(msg.chat.id, "Нет доменов с ошибками.");
        } else {
            let response = "Список доменов с ошибками:\n";

            domains.forEach(domain => {
                response += `Имя: ${domain.name}, Причина: ${domain.error}\n`;
            });

            bot.sendMessage(msg.chat.id, response);
        }
    }
});

const port = 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));