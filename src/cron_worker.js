import { createClient } from 'npm:@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY');
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

console.log('🔵 [CRON] cronWorker.js CARREGADO');

/**
 * ⚙️ PROCESSAR JOBS DE DISCIPLINAS/TÓPICOS (IA GERADA)
 */
async function processRegularJobs() {
  console.log('📝 [CRON] Processando jobs regulares (disciplinas/tópicos)...');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
    console.error('❌ [CRON] Variáveis de ambiente não configuradas');
    return { success: false, error: 'Config incompleta' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Buscar jobs pendentes SEM pdf_id
    const { data: jobs, error: jobsError } = await supabase
      .from('question_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .is('config->pdf_id', null) // ✅ APENAS jobs SEM PDF
      .order('created_at', { ascending: true })
      .limit(3);

    if (jobsError) {
      console.error('❌ [CRON] Erro ao buscar jobs regulares:', jobsError);
      return { success: false, error: jobsError.message };
    }

    if (!jobs || jobs.length === 0) {
      console.log('✅ [CRON] Nenhum job regular pendente');
      return { success: true, processed: 0 };
    }

    console.log(`🔄 [CRON] ${jobs.length} job(s) regular(es) encontrado(s)`);

    for (const job of jobs) {
      try {
        await processOneRegularJob(supabase, job);
      } catch (error) {
        console.error(`❌ [CRON] Erro ao processar job ${job.id}:`, error);
      }
    }

    return { success: true, processed: jobs.length };

  } catch (error) {
    console.error('❌ [CRON] Erro geral em processRegularJobs:', error);
    return { success: false, error: error.message };
  }
}

/**
 * ⚙️ PROCESSAR JOBS DE PDF (IA PDF)
 */
async function processPDFJobs() {
  console.log('📄 [CRON] Processando jobs de PDF...');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
    console.error('❌ [CRON] Variáveis de ambiente não configuradas');
    return { success: false, error: 'Config incompleta' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Buscar jobs pendentes COM pdf_id
    const { data: jobs, error: jobsError } = await supabase
      .from('question_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .not('config->pdf_id', 'is', null) // ✅ APENAS jobs COM PDF
      .order('created_at', { ascending: true })
      .limit(3);

    if (jobsError) {
      console.error('❌ [CRON] Erro ao buscar jobs de PDF:', jobsError);
      return { success: false, error: jobsError.message };
    }

    if (!jobs || jobs.length === 0) {
      console.log('✅ [CRON] Nenhum job de PDF pendente');
      return { success: true, processed: 0 };
    }

    console.log(`🔄 [CRON] ${jobs.length} job(s) de PDF encontrado(s)`);

    for (const job of jobs) {
      try {
        await processOnePDFJob(supabase, job);
      } catch (error) {
        console.error(`❌ [CRON] Erro ao processar job PDF ${job.id}:`, error);
      }
    }

    return { success: true, processed: jobs.length };

  } catch (error) {
    console.error('❌ [CRON] Erro geral em processPDFJobs:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔧 PROCESSAR UM JOB REGULAR (disciplinas/tópicos)
 */
async function processOneRegularJob(supabase, job) {
  console.log(`📝 [JOB ${job.id}] Processando job regular...`);
  
  const contexto_id = job.config?.contexto_id;
  
  if (!contexto_id) {
    throw new Error('contexto_id não encontrado no config');
  }

  // Marcar como processing
  await supabase
    .from('question_generation_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString()
    })
    .eq('id', job.id);

  // Buscar disciplinas do contexto
  const { data: contextoDiscs } = await supabase
    .from('contexto_disciplinas')
    .select('id, nome')
    .eq('contexto_id', contexto_id);

  const disciplinasMap = {};
  (contextoDiscs || []).forEach(d => {
    disciplinasMap[d.nome.toLowerCase()] = d.id;
  });

  // Gerar questões
  const questionIds = [];
  const totalQuestions = job.config.quantidade || 10;

  for (let i = 0; i < totalQuestions; i++) {
    try {
      console.log(`   [${i + 1}/${totalQuestions}] Gerando questão...`);

      const prompt = `Gere 1 questão de concurso público no formato JSON.

Configuração:
- Modalidade: ${job.config.modalidade || 'multipla_escolha'}
- Banca: ${job.config.banca || 'CESPE'}
- Dificuldade: ${job.config.dificuldade || 'medio'}
- Disciplinas: ${job.config.disciplinas_selecionadas?.join(', ') || 'Geral'}

Retorne APENAS JSON válido:
{
  "questoes": [{
    "enunciado": "Texto da questão",
    "alternativas": [
      {"letra": "A", "texto": "...", "correta": false},
      {"letra": "B", "texto": "...", "correta": true},
      {"letra": "C", "texto": "...", "correta": false},
      {"letra": "D", "texto": "...", "correta": false},
      {"letra": "E", "texto": "...", "correta": false}
    ],
    "explicacao": "Explicação detalhada",
    "dificuldade_estimada": 3,
    "disciplina": "Nome da disciplina"
  }]
}`;

      const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Você é um especialista em criar questões de concursos. Retorne JSON válido.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.8,
          response_format: { type: 'json_object' }
        })
      });

      if (!aiResponse.ok) {
        throw new Error(`OpenAI Error: ${aiResponse.statusText}`);
      }

      const aiData = await aiResponse.json();
      const content = aiData.choices[0]?.message?.content;

      if (!content) {
        throw new Error('OpenAI retornou resposta vazia');
      }

      const parsed = JSON.parse(content);
      const questao = parsed.questoes?.[0];

      if (!questao) {
        throw new Error('Questão não encontrada no JSON retornado');
      }

      // ✅ SALVAR NO SUPABASE
      const disciplina_id = disciplinasMap[questao.disciplina?.toLowerCase()] || null;
      const gabarito = questao.alternativas?.find(a => a.correta)?.letra || 'A';

      const { data: inserted, error: insertError } = await supabase
        .from('questoes_v2')
        .insert({
          user_email: job.user_email,
          contexto_id: contexto_id, // ✅ CRITICAL
          disciplina_id: disciplina_id,
          enunciado: questao.enunciado,
          tipo: job.config.modalidade === 'certo_errado' ? 'certo_errado' : 'multipla_escolha',
          alternativas: questao.alternativas,
          gabarito: gabarito,
          explicacao: questao.explicacao,
          banca: job.config.banca || 'CESPE',
          dificuldade: questao.dificuldade_estimada || 3,
          origem: 'ia_gerada',
          fonte: 'GPT-4o',
          publica: false
        })
        .select()
        .single();

      if (insertError) {
        console.error(`❌ Erro ao inserir questão:`, insertError);
        throw insertError;
      }

      questionIds.push(inserted.id);

      // Atualizar progresso
      const progress = Math.round(((i + 1) / totalQuestions) * 100);
      
      await supabase
        .from('question_generation_jobs')
        .update({
          questions_generated: i + 1,
          progress_percentage: progress,
          question_ids: questionIds
        })
        .eq('id', job.id);

      await new Promise(resolve => setTimeout(resolve, 1000)); // Delay de 1s

    } catch (error) {
      console.error(`❌ Erro ao gerar questão ${i + 1}:`, error);
    }
  }

  // Marcar como completed
  await supabase
    .from('question_generation_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      questions_generated: questionIds.length,
      progress_percentage: 100,
      question_ids: questionIds
    })
    .eq('id', job.id);

  // Criar notificação
  await supabase
    .from('UserNotification')
    .insert({
      user_email: job.user_email,
      type: 'question_generation',
      title: '✅ Questões geradas!',
      message: `${questionIds.length} questões foram geradas com sucesso!`,
      metadata: {
        job_id: job.id,
        status: 'completed',
        question_ids: questionIds
      }
    });

  console.log(`✅ [JOB ${job.id}] Concluído! ${questionIds.length} questões geradas`);
}

/**
 * 🔧 PROCESSAR UM JOB DE PDF
 */
async function processOnePDFJob(supabase, job) {
  console.log(`📄 [JOB ${job.id}] Processando job de PDF...`);
  
  const contexto_id = job.config?.contexto_id;
  const pdf_id = job.config?.pdf_id;
  
  if (!contexto_id || !pdf_id) {
    throw new Error('contexto_id ou pdf_id não encontrado no config');
  }

  // Marcar como processing
  await supabase
    .from('question_generation_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString()
    })
    .eq('id', job.id);

  // Buscar PDF
  const { data: pdf } = await supabase
    .from('questao_pdfs')
    .select('*')
    .eq('id', pdf_id)
    .single();

  if (!pdf || !pdf.extracted_data) {
    throw new Error('PDF não encontrado ou sem conteúdo extraído');
  }

  // Buscar disciplinas
  const { data: contextoDiscs } = await supabase
    .from('contexto_disciplinas')
    .select('id, nome')
    .eq('contexto_id', contexto_id);

  const disciplinasMap = {};
  (contextoDiscs || []).forEach(d => {
    disciplinasMap[d.nome.toLowerCase()] = d.id;
  });

  // Gerar questões
  const questionIds = [];
  const totalQuestions = job.config.total_questoes || 10;
  const conteudoPDF = pdf.extracted_data.substring(0, 8000); // Primeiros 8000 chars

  for (let i = 0; i < totalQuestions; i++) {
    try {
      console.log(`   [${i + 1}/${totalQuestions}] Gerando questão do PDF...`);

      const prompt = `Com base no conteúdo do PDF abaixo, gere 1 questão de concurso público.

CONTEÚDO DO PDF "${pdf.file_name}":
${conteudoPDF}

Configuração:
- Modalidade: ${job.config.modalidade || 'multipla_escolha'}
- Banca: ${job.config.banca || 'CESPE'}
- Dificuldade: ${job.config.dificuldade || 'medio'}
${job.config.disciplinas_selecionadas?.length > 0 ? `- Disciplinas: ${job.config.disciplinas_selecionadas.join(', ')}` : ''}
${job.config.instrucoes_extras ? `- Instruções extras: ${job.config.instrucoes_extras}` : ''}

Retorne APENAS JSON válido:
{
  "questoes": [{
    "enunciado": "Texto da questão (${job.config.instrucoes_extras?.includes('6 linhas') ? 'mínimo 6 linhas' : 'mínimo 3 linhas'})",
    "alternativas": [
      {"letra": "A", "texto": "...", "correta": false},
      {"letra": "B", "texto": "...", "correta": true},
      {"letra": "C", "texto": "...", "correta": false},
      {"letra": "D", "texto": "...", "correta": false},
      {"letra": "E", "texto": "...", "correta": false}
    ],
    "explicacao": "Explicação detalhada e didática",
    "dificuldade_estimada": 3,
    "disciplina": "Nome da disciplina"
  }]
}`;

      const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Você é um especialista em criar questões de concursos públicos. Retorne JSON válido.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.8,
          response_format: { type: 'json_object' }
        })
      });

      if (!aiResponse.ok) {
        throw new Error(`OpenAI Error: ${aiResponse.statusText}`);
      }

      const aiData = await aiResponse.json();
      const content = aiData.choices[0]?.message?.content;

      if (!content) {
        throw new Error('OpenAI retornou resposta vazia');
      }

      const parsed = JSON.parse(content);
      const questao = parsed.questoes?.[0];

      if (!questao) {
        throw new Error('Questão não encontrada no JSON retornado');
      }

      // ✅ SALVAR NO SUPABASE
      const disciplina_id = disciplinasMap[questao.disciplina?.toLowerCase()] || null;
      const gabarito = questao.alternativas?.find(a => a.correta)?.letra || 'A';

      const { data: inserted, error: insertError } = await supabase
        .from('questoes_v2')
        .insert({
          user_email: job.user_email,
          contexto_id: contexto_id, // ✅ CRITICAL
          disciplina_id: disciplina_id,
          pdf_origem_id: pdf_id, // ✅ Referência ao PDF
          enunciado: questao.enunciado,
          tipo: job.config.modalidade === 'certo_errado' ? 'certo_errado' : 'multipla_escolha',
          alternativas: questao.alternativas,
          gabarito: gabarito,
          explicacao: questao.explicacao,
          banca: job.config.banca || 'CESPE',
          dificuldade: questao.dificuldade_estimada || 3,
          origem: 'ia_pdf', // ✅ CRITICAL
          fonte: `PDF: ${pdf.file_name}`,
          publica: false
        })
        .select()
        .single();

      if (insertError) {
        console.error(`❌ Erro ao inserir questão:`, insertError);
        throw insertError;
      }

      questionIds.push(inserted.id);

      // Atualizar progresso
      const progress = Math.round(((i + 1) / totalQuestions) * 100);
      
      await supabase
        .from('question_generation_jobs')
        .update({
          questions_generated: i + 1,
          progress_percentage: progress,
          question_ids: questionIds
        })
        .eq('id', job.id);

      await new Promise(resolve => setTimeout(resolve, 2000)); // Delay de 2s para PDFs

    } catch (error) {
      console.error(`❌ Erro ao gerar questão ${i + 1} do PDF:`, error);
    }
  }

  // Marcar como completed
  await supabase
    .from('question_generation_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      questions_generated: questionIds.length,
      progress_percentage: 100,
      question_ids: questionIds
    })
    .eq('id', job.id);

  // Criar notificação
  await supabase
    .from('UserNotification')
    .insert({
      user_email: job.user_email,
      type: 'question_generation',
      title: '✅ Questões do PDF geradas!',
      message: `${questionIds.length} questões foram geradas do PDF "${pdf.file_name}"!`,
      metadata: {
        job_id: job.id,
        status: 'completed',
        question_ids: questionIds,
        pdf_name: pdf.file_name
      }
    });

  console.log(`✅ [JOB ${job.id}] Concluído! ${questionIds.length} questões geradas do PDF`);
}

/**
 * 🎯 HANDLER PRINCIPAL (chamado pelo Deno Cron)
 */
Deno.serve(async (req) => {
  console.log('🔵 [CRON] cronWorker executado!');
  
  try {
    // Processar jobs regulares
    const regularResult = await processRegularJobs();
    console.log('✅ [CRON] Jobs regulares:', regularResult);

    // Processar jobs de PDF
    const pdfResult = await processPDFJobs();
    console.log('✅ [CRON] Jobs de PDF:', pdfResult);

    return Response.json({
      success: true,
      regular: regularResult,
      pdf: pdfResult
    });

  } catch (error) {
    console.error('❌ [CRON] Erro geral no cronWorker:', error);
    return Response.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
});