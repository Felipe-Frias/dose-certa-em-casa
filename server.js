require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// CONEXÃO BANCO POSTGRESQL
const poolConfig = process.env.DATABASE_URL
  ? { 
      connectionString: process.env.DATABASE_URL, 
      ssl: { rejectUnauthorized: false } 
    }
  : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false }
    };

const db = new Pool(poolConfig);

async function testarConexao() {
  try {
    const client = await db.connect();
    console.log('✅ Conectado ao PostgreSQL com sucesso!');
    client.release();
  } catch (err) {
    console.error('❌ Erro de conexão:', err.message);
  }
}
testarConexao();

// LEMBRETES — sem WhatsApp na nuvem por enquanto
cron.schedule('* * * * *', async () => {
  try {
    const agora = new Date();
    const horaAtual = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`;
    const hoje = agora.toISOString().split('T')[0];

    const result = await db.query(`
      SELECT m.id, m.nome_medicamento, m.dosagem, m.usuario_id, u.nome_completo, u.telefone
      FROM medicamentos m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.lembretes_ativos = TRUE AND u.ativo = TRUE
        AND (TO_CHAR(m.horario1, 'HH24:MI')=$1 OR TO_CHAR(m.horario2, 'HH24:MI')=$1
          OR TO_CHAR(m.horario3, 'HH24:MI')=$1 OR TO_CHAR(m.horario4, 'HH24:MI')=$1)
    `, [horaAtual]);

    for (const med of result.rows) {
      const jaEnviado = await db.query(`
        SELECT id FROM historico_lembretes
        WHERE usuario_id=$1 AND medicamento_id=$2
          AND DATE(horario_envio)=$3
          AND TO_CHAR(horario_envio, 'HH24:MI')=$4
      `, [med.usuario_id, med.id, hoje, horaAtual]);
      
      if (jaEnviado.rows.length > 0) continue;

      console.log(`⏰ Lembrete: ${med.nome_completo} — ${med.nome_medicamento}`);
      
      await db.query(
        `INSERT INTO historico_lembretes (usuario_id, medicamento_id, horario_envio, tipo_notificacao, confirmou_tomada)
         VALUES ($1, $2, NOW(), 'navegador', FALSE)`,
        [med.usuario_id, med.id]
      );
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
  if (!token) return res.status(401).json({erro: 'Acesso negado'});
  
  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return res.status(403).json({erro: 'Token inválido'});
    req.usuario = usuario;
    next();
  });
}

// ROTAS
app.post('/api/cadastro', async (req, res) => {
  try {
    const {nome, cpf, telefone, email, endereco, senha, medicamento, dosagem, horarios} = req.body;
    const senhaHash = await bcrypt.hash(senha || cpf.replace(/\D/g,''), 10);
    
    const usuarioResult = await db.query(
      `INSERT INTO usuarios (nome_completo, cpf, telefone, email, endereco, senha_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [nome, cpf, telefone, email || null, endereco, senhaHash]
    );
    const usuarioId = usuarioResult.rows[0].id;

    if (medicamento) {
      await db.query(
        `INSERT INTO medicamentos (usuario_id, nome_medicamento, dosagem, horario1, horario2, horario3, lembretes_ativos)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [usuarioId, medicamento, dosagem, horarios?.[0] || null, horarios?.[1] || null, horarios?.[2] || null]
      );
    }

    res.status(201).json({mensagem: 'Cadastro realizado com sucesso!', id: usuarioId});
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({erro: 'CPF já cadastrado'});
    } else {
      res.status(500).json({erro: err.message});
    }
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const {cpf, senha} = req.body;
    const result = await db.query('SELECT * FROM usuarios WHERE cpf=$1 AND ativo=TRUE', [cpf]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({erro: 'Usuário não encontrado'});
    }
    
    const usuario = result.rows[0];
    const senhaCorreta = await bcrypt.compare(senha || cpf.replace(/\D/g,''), usuario.senha_hash);
    
    if (!senhaCorreta) {
      return res.status(401).json({erro: 'Senha incorreta'});
    }
    
    const token = jwt.sign(
      {id: usuario.id, nome: usuario.nome_completo},
      process.env.JWT_SECRET,
      {expiresIn: '24h'}
    );
    
    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome_completo,
        telefone: usuario.telefone
      }
    });
  } catch (err) {
    res.status(500).json({erro: err.message});
  }
});

app.get('/api/usuario/dados', autenticarToken, async (req, res) => {
  try {
    const usuarioRes = await db.query(
      'SELECT id, nome_completo, cpf, telefone, email, endereco FROM usuarios WHERE id=$1',
      [req.usuario.id]
    );
    const medRes = await db.query(
      'SELECT * FROM medicamentos WHERE usuario_id=$1 ORDER BY id DESC LIMIT 1',
      [req.usuario.id]
    );
    
    res.json({
      usuario: usuarioRes.rows[0],
      medicamento: medRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({erro: err.message});
  }
});

app.get('/api/status', (req, res) => {
  res.json({status: 'online', programa: 'Dose Certa — Aquidauana/MS'});
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`🚀 Servidor rodando na porta ${PORTA}`));
