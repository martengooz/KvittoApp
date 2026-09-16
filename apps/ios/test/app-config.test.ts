import config from '../app.config';

describe('app.config', () => {
  it('targets iOS only with no Android configuration', () => {
    expect(config.ios).toBeDefined();
    expect(config.android).toBeUndefined();
  });

  it('sets the iOS 26 deployment target', () => {
    expect(config.ios?.deploymentTarget).toBe('26.0');
  });

  it('declares the .kvitto document type', () => {
    const docTypes = config.ios?.infoPlist?.CFBundleDocumentTypes as
      | Array<{ LSItemContentTypes?: string[] }>
      | undefined;
    expect(docTypes?.some((type) => type.LSItemContentTypes?.includes('com.kvitto.archive.kvitto'))).toBe(
      true,
    );
  });

  it('declares camera and photo library usage descriptions', () => {
    expect(config.ios?.infoPlist?.NSCameraUsageDescription).toBeTruthy();
    expect(config.ios?.infoPlist?.NSPhotoLibraryUsageDescription).toBeTruthy();
  });

  it('registers the app scheme', () => {
    expect(config.scheme).toContain('kvittoapp');
  });

  it('keeps routes in app while src/app owns boot composition', () => {
    expect(config.extra?.router).toEqual({ root: 'app' });
  });
});
