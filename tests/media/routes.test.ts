import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, assertMutationOrigin } from "@/server/http";
const mocks = vi.hoisted(()=>({requireUser:vi.fn(),upload:vi.fn(),list:vi.fn(),remove:vi.fn(),readPrivate:vi.fn(),readPublic:vi.fn(),rate:vi.fn()}));
vi.mock("@/server/auth/session",()=>({requireUser:mocks.requireUser}));
vi.mock("@/server/rate-limit",()=>({rateLimit:mocks.rate}));
vi.mock("@/server/media/service",()=>({uploadMedia:mocks.upload,listOwnedMedia:mocks.list,deleteOwnedMedia:mocks.remove,readPrivateContent:mocks.readPrivate,readLocalPublicContent:mocks.readPublic}));
import { GET, POST } from "@/app/api/media/route";
import { serviceState } from "@/server/service-state";
vi.mock("@/server/service-state",()=>({serviceState:vi.fn()}));
import { DELETE } from "@/app/api/media/[id]/route";
import { GET as content } from "@/app/api/media/[id]/content/route";
import { GET as publicContent } from "@/app/media/[...key]/route";
beforeEach(()=>{
  vi.mocked(serviceState).mockResolvedValue("open");
  vi.stubEnv("SITE_DOMAIN","may-be.localhost");
  mocks.requireUser.mockImplementation(async (input?: Request | Headers) => {
    if (input && !(input instanceof Headers) && !["GET", "HEAD", "OPTIONS"].includes(input.method)) assertMutationOrigin(input);
    return { userId: "session-owner" };
  });
});
afterEach(()=>vi.unstubAllEnvs());
const profileId="11111111-1111-4111-8111-111111111111";
const headers={"x-editor-profile":profileId,host:"app.may-be.localhost",origin:"https://app.may-be.localhost","content-type":"text/plain","content-length":"1"};
describe("media HTTP contracts",()=>{
  it("enforces the upload boundary before reading bytes and secures every outcome",async()=>{
    for (const host of ["may-be.localhost","other.may-be.localhost","app.may-be.localhost:444","evil.invalid"]) {
      const denied=await POST(new Request("https://app.may-be.localhost/api/media?kind=image",{method:"POST",headers:{...headers,host},body:"x"}));
      expect(denied.status).toBe(404);expect(denied.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(denied.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    for (const pathname of ["/api/media/","/api/%6dedia","/api/media/content"]) {
      expect((await POST(new Request(`https://app.may-be.localhost${pathname}`,{method:"POST",headers,body:"x"}))).status).toBe(404);
    }
    expect((await GET(new Request("https://app.may-be.localhost/api/media",{method:"PUT",headers,body:"x"}))).headers.get("allow")).toBe("GET, HEAD, POST");
    vi.mocked(serviceState).mockResolvedValue("closed");
    const closed=await POST(new Request("https://app.may-be.localhost/api/media?kind=image",{method:"POST",headers,body:"x"}));
    expect(closed.status).toBe(503);expect(closed.headers.get("retry-after")).toBe("60");expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });
  it("requires editor identity for collection and deletion, but not native content loads",async()=>{
    const noIdentity={host:headers.host,origin:headers.origin};
    expect((await GET(new Request("https://app.may-be.localhost/api/media",{headers:noIdentity}))).status).toBe(400);
    expect((await POST(new Request("https://app.may-be.localhost/api/media?kind=image",{method:"POST",headers:noIdentity,body:"x"}))).status).toBe(400);
    expect((await DELETE(new Request("https://app.may-be.localhost/api/media/id",{method:"DELETE",headers:noIdentity}),{params:Promise.resolve({id:"id"})})).status).toBe(400);
    mocks.readPrivate.mockResolvedValue({body:Buffer.from("x"),object:{bytes:1,contentType:"image/webp"}});
    expect((await content(new Request("https://app.may-be.localhost/api/media/id/content",{headers:noIdentity}),{params:Promise.resolve({id:"id"})})).status).toBe(200);
  });
  it("requires the shared session and mutation origin; derives owner exclusively from it",async()=>{
    mocks.upload.mockResolvedValue({id:"asset",state:"quarantined"});
    const request=new Request("https://app.may-be.localhost/api/media?kind=image",{method:"POST",headers,body:Buffer.from("actual body longer than declared")});
    const response=await POST(request);expect(response.status).toBe(202);
    expect(mocks.requireUser).toHaveBeenCalledWith(request);expect(mocks.upload).toHaveBeenCalledWith("session-owner","image",request.body,profileId);
    const bad=await POST(new Request(request.url,{method:"POST",headers:{...headers,origin:"https://evil.invalid"},body:"x"}));
    expect(bad.status).toBe(403);expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect((await POST(new Request(request.url+"&ownerId=other",{method:"POST",headers,body:"x"}))).status).toBe(400);
  });
  it("requires authentication for listing and private content",async()=>{
    mocks.requireUser.mockRejectedValue(new AppError(401,"AUTH_REQUIRED","Sign in."));
    expect((await GET(new Request("https://app.may-be.localhost/api/media",{headers}))).status).toBe(401);
    const response = await content(new Request("https://app.may-be.localhost/api/media/id/content",{headers}),{params:Promise.resolve({id:"id"})});
    expect(response.status).toBe(401);
  });
  it("preserves retained-reference errors without exposing raw exceptions",async()=>{
    mocks.remove.mockRejectedValue(new AppError(409,"MEDIA_RETAINED","Asset is retained."));
    const req=new Request("https://app.may-be.localhost/api/media/id",{method:"DELETE",headers});
    const result=await DELETE(req,{params:Promise.resolve({id:"id"})});expect(result.status).toBe(409);
    expect(mocks.remove).toHaveBeenCalledWith("session-owner","id",profileId);
    mocks.remove.mockRejectedValue(new Error("secret provider token"));
    expect(await (await DELETE(req,{params:Promise.resolve({id:"id"})})).text()).not.toContain("secret");
  });
  it("allows local public content only on the media host and keeps private content same-origin",async()=>{
    const object={area:"private",key:"key",bytes:4,contentType:"audio/mpeg",durationMs:1000};
    mocks.readPrivate.mockResolvedValue({body:Buffer.from("data"),object});mocks.readPublic.mockResolvedValue({body:Buffer.from("data"),object});
    const result=await content(new Request("https://app.may-be.localhost/api/media/id/content",{headers}),{params:Promise.resolve({id:"id"})});
    expect(result.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const denied=await publicContent(new Request("https://app.may-be.localhost/media/key",{headers}),{params:Promise.resolve({key:["key"]})});expect(denied.status).toBe(404);
    const allowed=await publicContent(new Request("https://media.may-be.localhost/media/key",{headers:{host:"media.may-be.localhost"}}),{params:Promise.resolve({key:["key"]})});
    expect(allowed.status).toBe(200);expect(allowed.headers.get("cache-control")).toContain("no-store");
  });
});
