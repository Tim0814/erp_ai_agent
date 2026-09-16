import handler from '../../frontend/api/review/[recId]';

jest.mock('../../frontend/node_modules/@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockCreateClient = require('../../frontend/node_modules/@supabase/supabase-js').createClient as jest.Mock;

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

async function invokeReview(override_reason: unknown) {
  const response = makeResponse();
  await handler(
    {
      method: 'POST',
      query: { recId: 'recommendation-1' },
      body: { action: 'overridden', override_reason },
    } as never,
    response as never,
  );
  return response;
}

describe('覆寫審核原因驗證', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-key';
  });

  it.each([null, '', '   '])('override_reason 為 %p 時回傳 400', async (override_reason) => {
    const response = await invokeReview(override_reason);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: '覆寫 (overridden) 時必須填寫覆寫原因 (override_reason)',
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('override_reason 有實際內容時回傳成功', async () => {
    const data = { id: 'recommendation-1', review_action: 'overridden' };
    const single = jest.fn().mockResolvedValue({ data, error: null });
    const update = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ single }),
      }),
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn().mockReturnValue({ update }),
    } as never);

    const response = await invokeReview('客戶指定批次');

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ success: true, data });
  });
});
