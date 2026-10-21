require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cron = require('node-cron');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

// CONEXÃO BANCO
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

async function testarConexao() {
  try {
    const conn = await db.getConnection();
    console.log('✅ Conectado ao MySQL com sucesso!');
    conn.release();
  } catch (err) {
    console.error('❌ Erro MySQL:', err.message);
  }
}
testarConexao();

// WHATSAPP
const client = new Client({
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', qr => {
  console.log('\n📱 ESCANEIE COM SEU WHATSAPP:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp conectado com sucesso!');
});

client.initialize();

// ENVIAR MENSAGEM
async function enviarWhatsApp(telefone, mensagem) {
  try {
    let numero = telefone.replace(/\D/g, '');
    if (numero.length === 11) numero = '55' + numero;
    if (numero.length === 10) numero = '55' + numero;
    numero += '@c.us';
    console.log(`📤 Enviando para: ${numero}`);
    await client.sendMessage(numero, mensagem);
    console.log('✅ Mensagem enviada!');
    return true;
  } catch (err) {
    console.error('❌ Erro:', err.message);
    return false;
  }
}

// LEMBRETES AUTOMÁTICOS
cron.schedule('* * * * *', async () => {
  try {
    const agora = new Date();
    const horaAtual = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`;
    const hoje = agora.toISOString().split('T')[0];

    const [medicamentos] = await db.query(`
      SELECT m.id, m.nome_medicamento, m.dosagem, m.usuario_id, u.nome_completo, u.telefone
      FROM medicamentos m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.lembretes_ativos = TRUE AND u.ativo = TRUE
        AND (TIME_FORMAT(m.horario1,'%H:%i')=? OR TIME_FORMAT(m.horario2,'%H:%i')=?
          OR TIME_FORMAT(m.horario3,'%H:%i')=? OR TIME_FORMAT(m.horario4,'%H:%i')=?)
    `, [horaAtual, horaAtual, horaAtual, horaAtual]);

    for (const med of medicamentos) {
      const [jaEnviado] = await db.query(`
        SELECT id FROM historico_lembretes WHERE usuario_id=? AND medicamento_id=?
        AND DATE(horario_envio)=? AND TIME(horario_envio) BETWEEN ? AND ?
      `, [med.usuario_id, med.id, hoje, horaAtual+':00', horaAtual+':59']);
      if (jaEnviado.length > 0) continue;

      const msg = `💊 *Olá ${med.nome_completo.split(' ')[0]}!*\n\n⏰ Está na hora de tomar:\n\n*${med.nome_medicamento}*${med.dosagem?`\n💊 ${med.dosagem}`:''}\n\n📦 Dose Certa – Aquidauana/MS`;
      await enviarWhatsApp(med.telefone, msg);
      await db.query(`INSERT INTO historico_lembretes VALUES (NULL,?,?,NOW(),'whatsapp',1)`, [med.usuario_id, med.id]);
    }
  } catch (err) {
    console.error('❌ Erro agendador:', err.message);
  }
});
console.log('⏰ Agendador de lembretes iniciado');

// AUTENTICAÇÃO
function autenticarToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({erro:'Acesso negado'});
  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return res.status(403).json({erro:'Token inválido'});
    req.usuario = usuario;
    next();
  });
}

// ROTAS
app.post('/api/cadastro', async (req, res) => {
  try {
    const {nome,cpf,telefone,email,endereco,senha,medicamento,dosagem,horarios} = req.body;
    const senhaHash = await bcrypt.hash(senha || cpf.replace(/\D/g,''), 10);
    const [resUser] = await db.query(
      `INSERT INTO usuarios (nome_completo,cpf,telefone,email,endereco,senha_hash) VALUES (?,?,?,?,?,?)`,
      [nome,cpf,telefone,email||null,endereco,senhaHash]
    );
    await db.query(
      `INSERT INTO medicamentos VALUES (NULL,?,?,?,?,?,1)`,
      [resUser.insertId,medicamento,dosagem,horarios?.[0]||null,horarios?.[1]||null,horarios?.[2]||null]
    );
    setTimeout(()=>enviarWhatsApp(telefone,`💙 Bem-vindo ao Dose Certa!\n📦 ${medicamento}\n⏰ Lembretes ativados!`), 3000);
    res.status(201).json({mensagem:'Cadastrado!', id:resUser.insertId});
  } catch (err) {
    res.status(err.code==='ER_DUP_ENTRY'?400:500).json({erro:err.code==='ER_DUP_ENTRY'?'CPF já cadastrado':err.message});
  }
});

app.post('/api/login', async (req, res) => {
  const {cpf,senha} = req.body;
  const [usuarios] = await db.query('SELECT * FROM usuarios WHERE cpf=? AND ativo=1', [cpf]);
  if (!usuarios.length) return res.status(404).json({erro:'Usuário não encontrado'});
  const usuario = usuarios[0];
  const senhaOk = await bcrypt.compare(senha || cpf.replace(/\D/g,''), usuario.senha_hash);
  if (!senhaOk) return res.status(401).json({erro:'Senha incorreta'});
  const token = jwt.sign({id:usuario.id,nome:usuario.nome_completo}, process.env.JWT_SECRET, {expiresIn:'24h'});
  res.json({token, usuario:{id:usuario.id,nome:usuario.nome_completo,telefone:usuario.telefone}});
});

app.get('/api/usuario/dados', autenticarToken, async (req, res) => {
  const [usuarios] = await db.query('SELECT id,nome_completo,cpf,telefone,email,endereco FROM usuarios WHERE id=?', [req.usuario.id]);
  const [medicamentos] = await db.query('SELECT * FROM medicamentos WHERE usuario_id=?', [req.usuario.id]);
  res.json({usuario:usuarios[0], medicamentos});
});

app.get('/api/status', (req, res) => {
  res.json({status:'online', banco:'conectado', whatsapp:'ativo', programa:'Dose Certa'});
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`🚀 API rodando em http://localhost:${PORTA}`));