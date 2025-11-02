import { createClient } from 'npm:@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY');
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

/**
 * ⚙️ WORKER: Processa jobs de geração de questões
 * ✅ Gera em BATCHES de 10 para qualidade e evitar timeout
 */
async function processJobs() {
  console.log('🔵 [WORKER] Iniciando processJobs()...');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
    console.error('❌ [WORKER] Variáveis de ambiente não configuradas');
    return { success: false, error: 'Config incompleta' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Buscar jobs pendentes
    const { data: jobs, error: jobsError } = await supabase
      .from('question_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_date', { ascending: true })
      .limit(5);

    if (jobsError) {
      console.error('❌ [WORKER] Erro ao buscar jobs:', jobsError);
      return { success: false, error: jobsError.message };
    }

    if (!jobs || jobs.length === 0) {
      return { success: true, processed: 0 };
    }

    console.log(`🔄 [WORKER] Processando ${jobs.length} job(s)...`);

    for (const job of jobs) {
      try {
        console.log(`📝 [WORKER] Job ${job.id}`);
        
        const contexto_id = job.config?.contexto_id;
        
        if (!contexto_id) {
          throw new Error('contexto_id não encontrado');
        }
        
        // Marcar como processing
        await supabase
          .from('question_generation_jobs')
          .update({
            status: 'processing',
            started_at: new Date().toISOString()
          })
          .eq('id', job.id);

        // Buscar disciplinas e tópicos do contexto
        const { data: contextoDiscs } = await supabase
          .from('contexto_disciplinas')
          .select('id, nome')
          .eq('contexto_id', contexto_id);

        const { data: contextoTopicos } = await supabase
          .from('contexto_topicos')
          .select('id, nome, disciplina_id')
          .in('disciplina_id', (contextoDiscs || []).map(d => d.id));

        const disciplinasMap = {};
        (contextoDiscs || []).forEach(d => {
          disciplinasMap[d.nome.toLowerCase()] = d.id;
        });

        const topicosMap = {};
        (contextoTopicos || []).forEach(t => {
          topicosMap[t.nome.toLowerCase()] = { id: t.id, disciplina_id: t.disciplina_id };
        });

        // ✅ GERAR EM BATCHES DE 10
        const questionIds = [];
        const totalQuestions = job.config.quantidade || 10;
        const batchSize = 10;
        const numBatches = Math.ceil(totalQuestions / batchSize);

        console.log(`📦 [WORKER] Gerando em ${numBatches} batch(es) de ${batchSize} questões`);

        for (let batchNum = 0; batchNum < numBatches; batchNum++) {
          const questionsInBatch = Math.min(batchSize, totalQuestions - questionIds.length);
          
          console.log(`   📦 Batch ${batchNum + 1}/${numBatches}: ${questionsInBatch} questões`);

          // Montar prompt
          const disciplinasNomes = job.config.disciplinas?.map(d => d.nome || d).join(', ') || 'Geral';
          const assuntosNomes = job.config.assuntos?.map(a => a.nome || a).join(', ') || 'Geral';

          const prompt = `Gere ${questionsInBatch} questões de ${job.config.modalidade || 'múltipla escolha'} sobre:

Disciplina(s): ${disciplinasNomes}
Assunto(s): ${assuntosNomes}
Dificuldade: ${job.config.dificuldade || 'medio'}
${job.config.banca ? `Banca: ${job.config.banca}` : ''}
${job.config.ano ? `Ano: ${job.config.ano}` : ''}

Retorne APENAS um JSON válido no formato:
{
  "questoes": [{
    "enunciado": "Texto aqui",
    "disciplina": "${disciplinasNomes.split(',')[0].trim()}",
    "topico": "${assuntosNomes.split(',')[0].trim()}",
    "alternativas": [
      {"letra": "A", "texto": "..."},
      {"letra": "B", "texto": "..."},
      {"letra": "C", "texto": "..."},
      {"letra": "D", "texto": "..."},
      {"letra": "E", "texto": "..."}
    ],
    "gabarito": "C",
    "explicacao": "...",
    "dificuldade_estimada": 3
  }]
}`;

          // Chamar OpenAI
          const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-4o',
              messages: [
                {
                  role: 'system',
                  content: 'Você é um especialista em criar questões de concursos. Retorne SEMPRE JSON válido.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              response_format: { type: 'json_object' },
              temperature: 0.8,
              max_tokens: Math.min(1500 * questionsInBatch, 16384)
            })
          });

          if (!aiResponse.ok) {
            throw new Error(`OpenAI Error: ${aiResponse.status}`);
          }

          const aiData = await aiResponse.json();
          const content = aiData.choices[0].message.content;
          
          const parsed = JSON.parse(content);
          const questoesData = parsed.questoes || [parsed];

          // Salvar questões
          for (const q of questoesData) {
            const disciplinaNome = q.disciplina?.toLowerCase() || disciplinasNomes.split(',')[0].trim().toLowerCase();
            const topicoNome = q.topico?.toLowerCase() || assuntosNomes.split(',')[0].trim().toLowerCase();
            
            const disciplina_id = disciplinasMap[disciplinaNome] || null;
            const topicoData = topicosMap[topicoNome];
            const topico_id = topicoData?.id || null;

            const dificuldadeMap = { 'facil': 1, 'medio': 2, 'dificil': 3 };

            const questaoParaSalvar = {
              user_email: job.user_email,
              contexto_id: contexto_id,
              disciplina_id: disciplina_id,
              topico_id: topico_id,
              enunciado: q.enunciado,
              tipo: job.config.modalidade || 'multipla_escolha',
              alternativas: q.alternativas || null,
              gabarito: q.alternativas?.find(a => a.letra === q.gabarito)?.letra || q.gabarito,
              explicacao: q.explicacao || null,
              dificuldade: dificuldadeMap[job.config.dificuldade] || q.dificuldade_estimada || 2,
              banca: job.config.banca || null,
              ano: job.config.ano || null,
              origem: 'ia_gerada',
              fonte: `GPT-4o-job:${job.id}`,
              publica: false,
              tags: [q.disciplina, q.topico, job.config.banca].filter(Boolean)
            };

            const { data: questaoSalva, error: saveError } = await supabase
              .from('questoes_v2')
              .insert(questaoParaSalvar)
              .select()
              .single();

            if (saveError) {
              console.error(`   ❌ Erro ao salvar:`, saveError);
              continue;
            }

            questionIds.push(questaoSalva.id);
          }

          // Atualizar progresso
          const progressPercentage = Math.round((questionIds.length / totalQuestions) * 100);
          
          await supabase
            .from('question_generation_jobs')
            .update({
              questions_generated: questionIds.length,
              progress_percentage: progressPercentage,
              question_ids: questionIds
            })
            .eq('id', job.id);

          console.log(`   ✅ Batch ${batchNum + 1} concluído (${questionIds.length}/${totalQuestions})`);
        }

        // Marcar como completed
        await supabase
          .from('question_generation_jobs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString()
          })
          .eq('id', job.id);

        // Criar notificação de sucesso
        await supabase
          .from('UserNotification')
          .insert({
            user_email: job.user_email,
            type: 'question_generation',
            title: '✅ Questões geradas!',
            message: `${questionIds.length} de ${totalQuestions} questões foram geradas com sucesso!`,
            link: `/QuestoesV2Resolver?contexto=${contexto_id}`,
            icon: 'CheckCircle2',
            metadata: { 
              job_id: job.id, 
              status: 'completed', 
              question_ids: questionIds,
              contexto_id: contexto_id
            }
          });

        console.log(`✅ [WORKER] Job ${job.id} completado!`);

      } catch (jobError) {
        console.error(`❌ [WORKER] Erro no job ${job.id}:`, jobError);

        await supabase
          .from('question_generation_jobs')
          .update({
            status: 'failed',
            error_message: jobError.message,
            completed_at: new Date().toISOString()
          })
          .eq('id', job.id);

        await supabase
          .from('UserNotification')
          .insert({
            user_email: job.user_email,
            type: 'question_generation',
            title: '❌ Erro ao gerar questões',
            message: `Ocorreu um erro: ${jobError.message}`,
            icon: 'AlertCircle',
            metadata: { job_id: job.id, status: 'failed', error: jobError.message }
          });
      }
    }

    return { success: true, processed: jobs.length };

  } catch (error) {
    console.error('❌ [WORKER] Erro geral:', error);
    return { success: false, error: error.message };
  }
}

// ⏰ CRON - A cada 1 minuto
Deno.cron("Question Generation Worker", "*/1 * * * *", async () => {
  console.log('⏰ [CRON] Worker disparado');
  const result = await processJobs();
  console.log('⏰ [CRON] Resultado:', result);
});

// 🌐 HTTP Handler (testes manuais)
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    
    if (url.pathname === '/test' && req.method === 'GET') {
      const result = await processJobs();
      return Response.json(result);
    }
    
    return Response.json({ 
      status: 'Worker ativo',
      message: 'Use /test para executar manualmente'
    });
  } catch (error) {
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});